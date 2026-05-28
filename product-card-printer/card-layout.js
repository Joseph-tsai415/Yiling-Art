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
    // card width (the wrap margin). Price doesn't wrap.
    var DEFAULT_CONFIG = {
        title:        { x: 51.5, y: 23, size: 17, wrapPct: 80 },
        englishTitle: { x: 51.5, y: 30, size: 12, wrapPct: 80 },
        ingredients:  { x: 51.5, y: 44, size: 9,  wrapPct: 90 },
        allergens:    { x: 5.5,  y: 60, size: 9,  wrapPct: 68 },
        price:        { x: 97.5, y: 60, size: 14 },
    };

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
            var wrapped = measure(text, size, opts.wrapWidthMm);
            var heightMm = wrapped.length * size * lineHeight * PT_TO_MM;
            if (!opts.maxHeightMm || heightMm <= opts.maxHeightMm) {
                return { size: size, lines: wrapped, heightMm: heightMm, lineHeight: lineHeight };
            }
            chosen = size; lines = wrapped;
        }
        return { size: chosen, lines: lines, heightMm: lines.length * chosen * lineHeight * PT_TO_MM, lineHeight: lineHeight };
    }

    // fields: { title, englishTitle, ingredients, allergens (strings, may contain \n),
    //           priceLines (array of strings) }
    function layoutCard(fields, cfg, measure) {
        cfg = cfg || DEFAULT_CONFIG;
        var items = [];

        if (fields.title && cfg.title) {
            var ct = cfg.title;
            var ft = fitText(measure, fields.title, { wrapWidthMm: wrapMm(ct, 80), maxSize: ct.size, minSize: Math.max(6, ct.size * 0.6), lineHeight: 1.1 });
            items.push({ id: 'title', align: 'center', x: ct.x, y: ct.y, size: ft.size, lineHeight: ft.lineHeight, lines: ft.lines });
        }
        if (fields.englishTitle && cfg.englishTitle) {
            var ce = cfg.englishTitle;
            var fe = fitText(measure, fields.englishTitle, { wrapWidthMm: wrapMm(ce, 80), maxSize: ce.size, minSize: Math.max(5, ce.size * 0.6), lineHeight: 1.1 });
            items.push({ id: 'englishTitle', align: 'center', x: ce.x, y: ce.y, size: fe.size, lineHeight: fe.lineHeight, lines: fe.lines });
        }
        if (fields.ingredients && cfg.ingredients) {
            var ci = cfg.ingredients;
            var priceY = cfg.price ? cfg.price.y : CARD_H_MM;
            var budget = Math.max(3, priceY - 2 - ci.y);
            var fi = fitText(measure, fields.ingredients, { wrapWidthMm: wrapMm(ci, 90), maxHeightMm: budget, maxSize: ci.size, minSize: 4.5, lineHeight: 1 });
            items.push({ id: 'ingredients', align: 'center', x: ci.x, y: ci.y, size: fi.size, lineHeight: fi.lineHeight, lines: fi.lines });
        }
        if (fields.allergens && cfg.allergens) {
            var ca = cfg.allergens;
            var fa = fitText(measure, fields.allergens, { wrapWidthMm: wrapMm(ca, 68), maxHeightMm: Math.max(3, CARD_H_MM - ca.y - 1), maxSize: ca.size, minSize: 5, lineHeight: 1 });
            items.push({ id: 'allergens', align: 'left', x: ca.x, y: ca.y, size: fa.size, lineHeight: fa.lineHeight, lines: fa.lines });
        }
        if (fields.priceLines && fields.priceLines.length && cfg.price) {
            var cp = cfg.price;
            items.push({ id: 'price', align: 'right', x: cp.x, y: cp.y, size: cp.size, lineHeight: 1.1, lines: fields.priceLines });
        }
        return items;
    }

    root.CardLayout = {
        CARD_W_MM: CARD_W_MM,
        CARD_H_MM: CARD_H_MM,
        PT_TO_MM: PT_TO_MM,
        DEFAULT_CONFIG: DEFAULT_CONFIG,
        wrapMm: wrapMm,
        fitText: fitText,
        layoutCard: layoutCard,
    };
})(typeof self !== 'undefined' ? self : this);
