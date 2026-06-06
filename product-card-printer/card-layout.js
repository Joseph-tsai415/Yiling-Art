/*
 * Shared card layout — the SINGLE source of truth for how a card is drawn.
 * Loaded by both pdf-worker.js (importScripts) and index.html (<script>), so the
 * on-screen designer and the exported PDF use the exact same config + algorithm.
 *
 * The only engine-specific piece is text measurement, which is injected:
 *   measure(text, sizePt, wrapWidthMm) -> string[]   (the wrapped lines)
 * The worker passes a jsPDF-based measure; the designer passes a canvas-based one.
 *
 * layoutCard(...) returns a list of draw items the caller paints:
 *   { id, align, x, y, size, lineHeight, lines }
 * where x is the alignment anchor (centre-x for centre, left edge for left, right
 * edge for right), y is the top of the text, size is pt, lines are pre-wrapped.
 */
(function (root) {
    'use strict';

    var CARD_W_MM = 103;
    var CARD_H_MM = 73;
    var PT_TO_MM = 25.4 / 72;

    // Per-element layout. x/y in mm, size in pt, wrapPct = max text width as a % of
    // card width (the wrap margin). Price doesn't wrap. font = family name, weight =
    // numeric CSS weight (400 regular, 700 bold) — both editor and worker resolve the
    // matching TTF so screen and PDF use the identical face + advance widths.
    // lineHeight = line spacing multiplier (1.1 default; smaller packs lines tighter).
    // stroke = outline width in pt drawn around glyphs in the text colour (thickens the
    // letters; works on any font, e.g. to make single-weight Chocolate look heavier).
    // Cosmetic only — does NOT affect wrapping/layout.
    var DEFAULT_FONT = 'Chocolate Classical Sans';
    var DEFAULT_WEIGHT = 400;
    var DEFAULT_LINE_HEIGHT = 1.1;
    var DEFAULT_STROKE = 0.25;
    // price = whole price; priceHalf = half/slice price — independent elements since
    // v priceHalf split (each has its own position/size/font). priceHalf's default
    // sits one 12pt line below price, matching the old combined two-line stack.
    // legendPct: a parenthesised legend inside the price text — "(全)" or "（半）",
    // ASCII or fullwidth parens — auto-renders at this % of the element's size.
    var DEFAULT_LEGEND_PCT = 60;
    var DEFAULT_CONFIG = {
        title:        { x: 51.5, y: 23, size: 17, wrapPct: 80, font: DEFAULT_FONT, weight: DEFAULT_WEIGHT, lineHeight: 1.1,  stroke: 0 },
        englishTitle: { x: 51.5, y: 30.5, size: 12, wrapPct: 85, font: 'Queenia', weight: DEFAULT_WEIGHT, lineHeight: 1.1,  stroke: 0.25 },
        ingredients:  { x: 51.5, y: 38, size: 9,  wrapPct: 79, font: DEFAULT_FONT, weight: DEFAULT_WEIGHT, lineHeight: 1.1,  stroke: 0 },
        allergens:    { x: 5.5,  y: 57.5, size: 9,  wrapPct: 68, font: DEFAULT_FONT, weight: DEFAULT_WEIGHT, lineHeight: 1.25, stroke: 0 },
        price:        { x: 83, y: 57.5, size: 12, font: DEFAULT_FONT, weight: DEFAULT_WEIGHT, lineHeight: 1.1,  stroke: 0, legendPct: DEFAULT_LEGEND_PCT },
        priceHalf:    { x: 83, y: 62.5, size: 12, font: DEFAULT_FONT, weight: DEFAULT_WEIGHT, lineHeight: 1.1,  stroke: 0, legendPct: DEFAULT_LEGEND_PCT },
    };

    // Split a price line into main/legend segments. A legend is any parenthesised
    // run — ASCII "(全)" or fullwidth "（半）" — drawn at legendPct% of the element
    // size by both the editor and the PDF worker.
    var LEGEND_SPLIT_RE = /([(（][^)）]*[)）])/;
    var LEGEND_MATCH_RE = /^[(（][^)）]*[)）]$/;
    function legendSegments(line) {
        var out = [];
        String(line).split(LEGEND_SPLIT_RE).forEach(function (part) {
            if (!part) return;
            out.push({ text: part, legend: LEGEND_MATCH_RE.test(part) });
        });
        return out.length ? out : [{ text: String(line), legend: false }];
    }

    function wrapMm(c, fallback) {
        return CARD_W_MM * ((c && c.wrapPct ? c.wrapPct : fallback) / 100);
    }

    // Largest size in [minSize, maxSize] (0.5pt steps) whose wrapped lines fit
    // maxHeightMm (if given). Returns { size, lines, heightMm, lineHeight }.
    function fitText(measure, text, opts) {
        var lineHeight = opts.lineHeight || 1.1;
        var minSize = opts.minSize || 4;
        var chosen = minSize;
        var lines = [String(text)];
        for (var size = opts.maxSize; size >= minSize - 1e-9; size -= 0.5) {
            var wrapped = measure(text, size, opts.wrapWidthMm, opts.font, opts.weight);
            var heightMm = wrapped.length * size * lineHeight * PT_TO_MM;
            if (!opts.maxHeightMm || heightMm <= opts.maxHeightMm) {
                return { size: size, lines: wrapped, heightMm: heightMm, lineHeight: lineHeight };
            }
            chosen = size; lines = wrapped;
        }
        return { size: chosen, lines: lines, heightMm: lines.length * chosen * lineHeight * PT_TO_MM, lineHeight: lineHeight };
    }

    // fields: { title, englishTitle, ingredients, allergens, price, priceHalf
    //           (strings, may contain \n) }
    // Resolve an element's font/weight, falling back to the defaults so older
    // configs (no font field) and partial configs still render.
    function fontOf(c) { return (c && c.font) || DEFAULT_FONT; }
    function weightOf(c) { return (c && c.weight) || DEFAULT_WEIGHT; }
    function lineHeightOf(c) { return (c && c.lineHeight) || DEFAULT_LINE_HEIGHT; }
    function strokeOf(c) { return (c && typeof c.stroke === 'number') ? c.stroke : DEFAULT_STROKE; }  // 0 is valid
    function legendPctOf(c) { return (c && typeof c.legendPct === 'number') ? c.legendPct : DEFAULT_LEGEND_PCT; }

    function layoutCard(fields, cfg, measure) {
        cfg = cfg || DEFAULT_CONFIG;
        var items = [];

        if (fields.title && cfg.title) {
            var ct = cfg.title;
            var ft = fitText(measure, fields.title, { wrapWidthMm: wrapMm(ct, 80), maxSize: ct.size, minSize: Math.max(6, ct.size * 0.6), lineHeight: lineHeightOf(ct), font: fontOf(ct), weight: weightOf(ct) });
            items.push({ id: 'title', align: 'center', x: ct.x, y: ct.y, size: ft.size, lineHeight: ft.lineHeight, lines: ft.lines, font: fontOf(ct), weight: weightOf(ct), stroke: strokeOf(ct) });
        }
        if (fields.englishTitle && cfg.englishTitle) {
            var ce = cfg.englishTitle;
            var fe = fitText(measure, fields.englishTitle, { wrapWidthMm: wrapMm(ce, 80), maxSize: ce.size, minSize: Math.max(5, ce.size * 0.6), lineHeight: lineHeightOf(ce), font: fontOf(ce), weight: weightOf(ce) });
            items.push({ id: 'englishTitle', align: 'center', x: ce.x, y: ce.y, size: fe.size, lineHeight: fe.lineHeight, lines: fe.lines, font: fontOf(ce), weight: weightOf(ce), stroke: strokeOf(ce) });
        }
        if (fields.ingredients && cfg.ingredients) {
            var ci = cfg.ingredients;
            var priceY = cfg.price ? cfg.price.y : CARD_H_MM;
            var budget = Math.max(3, priceY - 2 - ci.y);
            var fi = fitText(measure, fields.ingredients, { wrapWidthMm: wrapMm(ci, 90), maxHeightMm: budget, maxSize: ci.size, minSize: 4.5, lineHeight: lineHeightOf(ci), font: fontOf(ci), weight: weightOf(ci) });
            items.push({ id: 'ingredients', align: 'center', x: ci.x, y: ci.y, size: fi.size, lineHeight: fi.lineHeight, lines: fi.lines, font: fontOf(ci), weight: weightOf(ci), stroke: strokeOf(ci) });
        }
        if (fields.allergens && cfg.allergens) {
            var ca = cfg.allergens;
            var fa = fitText(measure, fields.allergens, { wrapWidthMm: wrapMm(ca, 68), maxHeightMm: Math.max(3, CARD_H_MM - ca.y - 1), maxSize: ca.size, minSize: 5, lineHeight: lineHeightOf(ca), font: fontOf(ca), weight: weightOf(ca) });
            items.push({ id: 'allergens', align: 'left', x: ca.x, y: ca.y, size: fa.size, lineHeight: fa.lineHeight, lines: fa.lines, font: fontOf(ca), weight: weightOf(ca), stroke: strokeOf(ca) });
        }
        // Whole and half price are independent elements. Legacy fallbacks: a config
        // without priceHalf stacks both under price (the old combined behaviour);
        // old callers passing fields.priceLines still render under price.
        var priceText = fields.price || (fields.priceLines && fields.priceLines.length ? fields.priceLines.join('\n') : '');
        if (cfg.price) {
            var priceLines = priceText ? String(priceText).split('\n') : [];
            if (fields.priceHalf && !cfg.priceHalf) priceLines = priceLines.concat(String(fields.priceHalf).split('\n'));
            if (priceLines.length) {
                var cp = cfg.price;
                items.push({ id: 'price', align: 'left', x: cp.x, y: cp.y, size: cp.size, lineHeight: lineHeightOf(cp), lines: priceLines, font: fontOf(cp), weight: weightOf(cp), stroke: strokeOf(cp), legendPct: legendPctOf(cp) });
            }
        }
        if (fields.priceHalf && cfg.priceHalf) {
            var ch = cfg.priceHalf;
            items.push({ id: 'priceHalf', align: 'left', x: ch.x, y: ch.y, size: ch.size, lineHeight: lineHeightOf(ch), lines: String(fields.priceHalf).split('\n'), font: fontOf(ch), weight: weightOf(ch), stroke: strokeOf(ch), legendPct: legendPctOf(ch) });
        }
        return items;
    }

    // Stable internal id for a (family, weight) face — used as the jsPDF font name
    // in the worker and as the FontFace cache key in the editor, so both halves
    // agree on which embedded face a draw item refers to.
    function fontKey(family, weight) {
        return String(family || DEFAULT_FONT).replace(/[^A-Za-z0-9]/g, '') + '_' + (weight || DEFAULT_WEIGHT);
    }

    root.CardLayout = {
        CARD_W_MM: CARD_W_MM,
        CARD_H_MM: CARD_H_MM,
        PT_TO_MM: PT_TO_MM,
        DEFAULT_CONFIG: DEFAULT_CONFIG,
        DEFAULT_FONT: DEFAULT_FONT,
        DEFAULT_WEIGHT: DEFAULT_WEIGHT,
        DEFAULT_LINE_HEIGHT: DEFAULT_LINE_HEIGHT,
        DEFAULT_STROKE: DEFAULT_STROKE,
        DEFAULT_LEGEND_PCT: DEFAULT_LEGEND_PCT,
        wrapMm: wrapMm,
        fitText: fitText,
        layoutCard: layoutCard,
        legendSegments: legendSegments,
        fontKey: fontKey,
    };
})(typeof self !== 'undefined' ? self : this);
