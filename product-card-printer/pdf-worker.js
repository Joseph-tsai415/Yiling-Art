/*
 * PDF rendering worker — the single source of truth for card layout.
 *
 * Runs off the main thread so building the document (which embeds a ~12 MB CJK
 * font and serializes the whole PDF) never freezes the page. Receives the card
 * data + layout params, fetches the font and background once (cached in worker
 * globals), draws every card with CMYK text, and posts the PDF back as an
 * ArrayBuffer (transferable).
 */
/* global importScripts, self, CardLayout */
importScripts('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js');
// Reuse this worker's own cache-bust token (?v=… from the Worker URL) so the shared
// layout module is always the same fresh copy the page loaded — no manual versioning.
importScripts('card-layout.js' + (self.location.search || ''));

const CARD_W_MM = CardLayout.CARD_W_MM;
const CARD_H_MM = CardLayout.CARD_H_MM;

// #fbf6ed as CMYK 0–1 fractions (jsPDF writes k-operator values verbatim, and the
// PDF spec requires 0–1). R=251 G=246 B=237 → C=0, M≈0.02, Y≈0.056, K≈0.016.
// Round-trips back to RGB(251,246,237) = #fbf6ed.
const CARD_TEXT_CMYK = [0, 0.0199, 0.0558, 0.0157];

const PAGES = {
    'a4-portrait':  { w: 210, h: 297, jsOrientation: 'p', jsFormat: 'a4', label: 'A4 portrait' },
    'a4-landscape': { w: 297, h: 210, jsOrientation: 'l', jsFormat: 'a4', label: 'A4 landscape' },
    'a3-portrait':  { w: 297, h: 420, jsOrientation: 'p', jsFormat: 'a3', label: 'A3 portrait' },
    'a3-landscape': { w: 420, h: 297, jsOrientation: 'l', jsFormat: 'a3', label: 'A3 landscape' },
};

// Fonts cached across messages (keyed by CardLayout.fontKey) so re-renders don't
// re-download. The main thread sends a { fontKey: ttfUrl } map of every face used
// by the selected cards. Each font is SUBSET to just the glyphs actually used on the
// cards before embedding (a full CJK TTF is ~12 MB / 10k+ glyphs; the cards use a few
// hundred chars), which turns a ~6 s / ~23 MB build into a sub-second / <1 MB one.
// The background is supplied as a ready data URL (fetched once on the main thread),
// so the worker never touches S3 and there's no CORS to worry about here.
let fontBytesMap = {};      // fontKey -> Uint8Array (full TTF, downloaded once)
let subsetB64Cache = {};    // "fontKey|codepoint-signature" -> base64 subset (or full) TTF
let embeddedKeys = new Set();
let defaultFontKey = null;

async function fetchAsBytes(url) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(url + ' → HTTP ' + resp.status);
    return new Uint8Array(await resp.arrayBuffer());
}

function bytesToBase64(bytes) {
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + chunk, bytes.length)));
    }
    return btoa(binary);
}

// ---- Font subsetting via hb-subset (harfbuzz WASM) ----
// Loaded lazily once. If it fails to load/run we fall back to embedding the full font
// (slower, but correct), so subsetting can never break rendering — only speed it up.
const HB_SUBSET_WASM = 'https://cdn.jsdelivr.net/npm/harfbuzzjs@0.4.6/hb-subset.wasm';
let _hbPromise = null;
function getHbSubset() {
    if (!_hbPromise) {
        _hbPromise = fetch(HB_SUBSET_WASM)
            .then(r => { if (!r.ok) throw new Error('hb-subset.wasm HTTP ' + r.status); return r.arrayBuffer(); })
            .then(buf => WebAssembly.instantiate(buf, {}))
            .then(res => res.instance.exports)
            .catch(err => { _hbPromise = null; throw err; });   // allow retry next render
    }
    return _hbPromise;
}

// Subset `fontBytes` to the given Unicode codepoints; returns a Uint8Array TTF.
// Throws on any failure so the caller can fall back to the full font.
function subsetFont(hb, fontBytes, codepoints) {
    const heap = () => new Uint8Array(hb.memory.buffer);
    const fontPtr = hb.malloc(fontBytes.length);
    heap().set(fontBytes, fontPtr);                        // view taken AFTER malloc (memory may grow)
    const blob = hb.hb_blob_create(fontPtr, fontBytes.length, 2 /* WRITABLE */, 0, 0);
    const face = hb.hb_face_create(blob, 0);
    hb.hb_blob_destroy(blob);
    const input = hb.hb_subset_input_create_or_fail();
    try {
        if (!input) throw new Error('hb_subset_input_create_or_fail');
        const unicodes = hb.hb_subset_input_unicode_set(input);
        hb.hb_set_add(unicodes, 0x20);                     // always keep space
        for (let i = 0; i < codepoints.length; i++) hb.hb_set_add(unicodes, codepoints[i]);
        const subsetFace = hb.hb_subset_or_fail(face, input);
        if (!subsetFace) throw new Error('hb_subset_or_fail');
        const resultBlob = hb.hb_face_reference_blob(subsetFace);
        const dataPtr = hb.hb_blob_get_data(resultBlob, 0);
        const len = hb.hb_blob_get_length(resultBlob);
        const out = heap().slice(dataPtr, dataPtr + len);  // copy out before freeing
        hb.hb_blob_destroy(resultBlob);
        hb.hb_face_destroy(subsetFace);
        return out;
    } finally {
        hb.hb_subset_input_destroy(input);
        hb.hb_face_destroy(face);
        hb.free(fontPtr);
    }
}

function unescapeNewlines(s) {
    return String(s || '').replace(/\\n/g, '\n');
}

function cellFor(row, map, fieldId) {
    const idx = map[fieldId];
    if (idx === undefined || idx < 0 || idx >= row.length) return '';
    return unescapeNewlines(row[idx]);
}

// The display text per card element (mirrors the editor). Used by both drawCard and
// the subsetting pass, so the glyphs we keep exactly match the glyphs we draw.
function buildFields(row, map) {
    return {
        title: cellFor(row, map, 'title'),
        englishTitle: cellFor(row, map, 'englishTitle'),
        ingredients: ['cnIngredients', 'enIngredients'].map(s => cellFor(row, map, s)).filter(Boolean).join('\n'),
        allergens: ['diet', 'allergens'].map(s => cellFor(row, map, s)).filter(Boolean).join('\n'),
        price: cellFor(row, map, 'priceWhole'),
        priceHalf: cellFor(row, map, 'priceHalf'),
    };
}

// ---- MaxRects bin packing (identical cards, rotation allowed) ----
// Greedy Maximal-Rectangles packer with Best-Short-Side-Fit. Cards may be placed
// upright (103×73) or rotated 90° (73×103); the algorithm fills leftover strips
// with rotated cards, which can beat a uniform grid (e.g. 5 on A4 portrait vs 4).
function rectsIntersect(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}
function rectContains(a, b) {   // does a fully contain b?
    return b.x >= a.x - 1e-6 && b.y >= a.y - 1e-6 &&
        b.x + b.w <= a.x + a.w + 1e-6 && b.y + b.h <= a.y + a.h + 1e-6;
}
function pruneFree(free) {
    const out = [];
    for (let i = 0; i < free.length; i++) {
        let contained = false;
        for (let j = 0; j < free.length; j++) {
            if (i === j) continue;
            if (rectContains(free[j], free[i]) && !(rectContains(free[i], free[j]) && i < j)) {
                contained = true; break;
            }
        }
        if (!contained) out.push(free[i]);
    }
    return out;
}
function packMaxRects(W, H, gutter) {
    const fpW = CARD_W_MM + gutter, fpH = CARD_H_MM + gutter;   // footprints incl. gutter
    const EPS = 1e-6;
    // Expand the area by one gutter so the trailing row/column doesn't need a gutter.
    let free = [{ x: 0, y: 0, w: W + gutter, h: H + gutter }];
    const placed = [];
    while (true) {
        let best = null;
        for (const fr of free) {
            const opts = [{ w: fpW, h: fpH, rotated: false }, { w: fpH, h: fpW, rotated: true }];
            for (const o of opts) {
                if (o.w <= fr.w + EPS && o.h <= fr.h + EPS) {
                    const shortSide = Math.min(fr.w - o.w, fr.h - o.h);
                    const longSide = Math.max(fr.w - o.w, fr.h - o.h);
                    if (!best || shortSide < best.shortSide - EPS ||
                        (Math.abs(shortSide - best.shortSide) < EPS && longSide < best.longSide - EPS)) {
                        best = { x: fr.x, y: fr.y, w: o.w, h: o.h, rotated: o.rotated, shortSide, longSide };
                    }
                }
            }
        }
        if (!best) break;
        placed.push({ x: best.x, y: best.y, rotated: best.rotated });
        const used = { x: best.x, y: best.y, w: best.w, h: best.h };
        const next = [];
        for (const fr of free) {
            if (!rectsIntersect(fr, used)) { next.push(fr); continue; }
            if (used.x > fr.x + EPS) next.push({ x: fr.x, y: fr.y, w: used.x - fr.x, h: fr.h });
            if (used.x + used.w < fr.x + fr.w - EPS) next.push({ x: used.x + used.w, y: fr.y, w: (fr.x + fr.w) - (used.x + used.w), h: fr.h });
            if (used.y > fr.y + EPS) next.push({ x: fr.x, y: fr.y, w: fr.w, h: used.y - fr.y });
            if (used.y + used.h < fr.y + fr.h - EPS) next.push({ x: fr.x, y: used.y + used.h, w: fr.w, h: (fr.y + fr.h) - (used.y + used.h) });
        }
        free = pruneFree(next);
    }
    return placed;
}

// Pack the chosen page with MaxRects and return the per-page card slots (x,y in mm
// within the usable area, plus a rotated flag). The user picks the page/orientation
// and tunes the margin; the packer always fills it optimally (rotating where it helps).
function computeLayout(pageFormat, margin, gutter) {
    margin = Math.max(0, margin || 0);
    gutter = Math.max(0, gutter || 0);
    const page = PAGES[pageFormat] || PAGES['a4-portrait'];
    const W = page.w - margin * 2;
    const H = page.h - margin * 2;
    const slots = packMaxRects(W, H, gutter);
    const cardArea = CARD_W_MM * CARD_H_MM;
    const wastePct = (W > 0 && H > 0) ? Math.max(0, (1 - (slots.length * cardArea) / (W * H)) * 100) : 100;
    return {
        page, margin, gutter, slots,
        perPage: slots.length,
        wastePct,
        rotatedCount: slots.filter(s => s.rotated).length,
    };
}

function drawCard(doc, cardX, cardY, row, map, bg, cfg) {
    if (bg.cmyk) {
        doc.addImage(bg.cmyk, 'JPEG', cardX, cardY, CARD_W_MM, CARD_H_MM, undefined, 'NONE');
    } else {
        doc.addImage(bg.png, 'PNG', cardX, cardY, CARD_W_MM, CARD_H_MM, undefined, 'NONE');
    }
    doc.setTextColor.apply(doc, CARD_TEXT_CMYK);

    // Pick the embedded face for this element, falling back to the default if the
    // requested one wasn't supplied (keeps a missing font from throwing mid-render).
    const faceKey = (font, weight) => {
        const k = CardLayout.fontKey(font, weight);
        return embeddedKeys.has(k) ? k : defaultFontKey;
    };

    const fields = buildFields(row, map);
    // jsPDF text measurement — the engine-specific half of the shared algorithm.
    // Advance widths depend on the face, so set the element's font before measuring.
    const measure = (text, sizePt, wrapWidthMm, font, weight) => {
        doc.setFont(faceKey(font, weight), 'normal');
        doc.setFontSize(sizePt);
        return doc.splitTextToSize(text, wrapWidthMm);
    };
    const items = CardLayout.layoutCard(fields, cfg, measure);
    items.forEach(it => {
        doc.setFont(faceKey(it.font, it.weight), 'normal');
        doc.setFontSize(it.size);
        doc.setLineHeightFactor(it.lineHeight);
        const opts = { align: it.align, baseline: 'top' };
        if (it.stroke > 0) {
            // Outline the glyphs in the text colour (pt → mm) to thicken them. jsPDF resets
            // the render mode to fill after a fillThenStroke call, so plain items are unaffected.
            doc.setLineWidth(it.stroke * CardLayout.PT_TO_MM);
            doc.setDrawColor.apply(doc, CARD_TEXT_CMYK);
            opts.renderingMode = 'fillThenStroke';
        }
        // Legend-aware elements (prices): a parenthesised "(全)"/"（半）" run renders
        // at legendPct% of the element size. Composed segment-by-segment — from the
        // left edge for left-aligned items, from the right edge for right-aligned —
        // with legend tops nudged down so baselines visually align.
        const hasLegend = typeof it.legendPct === 'number' && it.legendPct < 100 &&
            it.lines.some(l => CardLayout.legendSegments(l).some(s => s.legend));
        if (hasLegend && it.align !== 'center') {
            const legendSize = it.size * (it.legendPct / 100);
            it.lines.forEach((line, li) => {
                const yTop = cardY + it.y + li * it.size * it.lineHeight * CardLayout.PT_TO_MM;
                const segs = CardLayout.legendSegments(line);
                if (it.align === 'right') segs.reverse();   // walk right→left from the right edge
                let cursor = cardX + it.x;
                segs.forEach(seg => {
                    const size = seg.legend ? legendSize : it.size;
                    doc.setFontSize(size);
                    const w = doc.getTextWidth(seg.text);
                    if (it.align === 'right') cursor -= w;
                    const yOff = seg.legend ? (it.size - size) * 0.8 * CardLayout.PT_TO_MM : 0;
                    doc.text(seg.text, cursor, yTop + yOff, { align: 'left', baseline: 'top', renderingMode: opts.renderingMode });
                    if (it.align !== 'right') cursor += w;
                });
            });
            doc.setFontSize(it.size);   // restore for the next item
        } else {
            doc.text(it.lines, cardX + it.x, cardY + it.y, opts);
        }
    });
}

// Draw a card upright at (x,y), or rotated 90° CW into a 73×103 footprint at (x,y).
// Rotation uses a CTM (determinant +1, no mirroring); the card is drawn in its own
// 0,0 origin and the matrix places + rotates it.
function placeCard(doc, page, x, y, rotated, row, map, bg, cfg) {
    if (!rotated) {
        drawCard(doc, x, y, row, map, bg, cfg);
        return;
    }
    const k = 72 / 25.4;
    const Hpt = page.h * k;
    const e = (x + CARD_H_MM) * k - Hpt;
    const f = Hpt - y * k;
    doc.saveGraphicsState();
    doc.setCurrentTransformationMatrix(new doc.Matrix(0, -1, 1, 0, e, f));
    drawCard(doc, 0, 0, row, map, bg, cfg);
    doc.restoreGraphicsState();
}

// Which Unicode codepoints each embedded face actually needs, by walking every card's
// text and the font assigned to each element. An element whose font wasn't supplied
// falls back to the default face (matching drawCard), so its glyphs go to that key.
function collectCodepoints(rows, map, config, cardConfigs, faces) {
    const byKey = {};
    const ensure = k => (byKey[k] || (byKey[k] = new Set()));
    const effKey = (c) => {
        const k = CardLayout.fontKey((c && c.font), (c && c.weight));
        return faces[k] ? k : defaultFontKey;
    };
    const addText = (set, text) => { for (const ch of String(text || '')) set.add(ch.codePointAt(0)); };
    rows.forEach((row, i) => {
        const cfg = (cardConfigs && cardConfigs[i]) || config || CardLayout.DEFAULT_CONFIG;
        const f = buildFields(row, map);
        const elems = {
            title: f.title, englishTitle: f.englishTitle, ingredients: f.ingredients,
            allergens: f.allergens, price: f.price, priceHalf: f.priceHalf,
        };
        Object.keys(elems).forEach(id => { if (cfg[id]) addText(ensure(effKey(cfg[id])), elems[id]); });
        // Legacy config without a priceHalf element: its text renders under `price`
        // (see layoutCard fallback), so its glyphs must land in price's face subset.
        if (!cfg.priceHalf && cfg.price && f.priceHalf) addText(ensure(effKey(cfg.price)), f.priceHalf);
    });
    return byKey;
}

self.onmessage = async (e) => {
    const { rows, map, pageFormat, margin, gutter, fontUrl, fontFiles, defaultKey, bgDataUrl, bgCmykDataUrl, config, cardConfigs } = e.data;
    try {
        // { fontKey: ttfUrl } for every face used by the selected cards. Older callers
        // that only send a single fontUrl still work via the default key.
        const faces = fontFiles || {};
        defaultFontKey = defaultKey || CardLayout.fontKey(CardLayout.DEFAULT_FONT, CardLayout.DEFAULT_WEIGHT);
        if (!faces[defaultFontKey] && fontUrl) faces[defaultFontKey] = fontUrl;
        // Download each full font once (raw bytes, for subsetting).
        for (const key in faces) {
            if (!fontBytesMap[key]) fontBytesMap[key] = await fetchAsBytes(faces[key]);
        }
        const usedByKey = collectCodepoints(rows, map, config, cardConfigs, faces);
        const hb = await getHbSubset().catch(() => null);   // null → fall back to full fonts

        const bg = { png: bgDataUrl, cmyk: bgCmykDataUrl || null };

        const layout = computeLayout(pageFormat, margin, gutter);
        const { jsPDF } = self.jspdf;
        const doc = new jsPDF({
            orientation: layout.page.jsOrientation,
            unit: 'mm',
            format: layout.page.jsFormat,
            compress: true,
        });
        embeddedKeys = new Set();
        for (const key in faces) {
            const codepoints = Array.from(usedByKey[key] || []).sort((a, b) => a - b);
            // Cache the subset by face + exact glyph set, so layout-only re-renders
            // (position/size/weight tweaks that don't change text) skip re-subsetting.
            const cacheKey = key + '|' + (hb ? codepoints.join(',') : 'FULL');
            let b64 = subsetB64Cache[cacheKey];
            if (!b64) {
                let bytes = fontBytesMap[key];
                if (hb) {
                    try { bytes = subsetFont(hb, fontBytesMap[key], codepoints); }
                    catch (_) { bytes = fontBytesMap[key]; }   // subsetting failed → embed full font
                }
                b64 = bytesToBase64(bytes);
                subsetB64Cache[cacheKey] = b64;
            }
            const file = key + '.ttf';
            doc.addFileToVFS(file, b64);
            doc.addFont(file, key, 'normal');
            embeddedKeys.add(key);
        }

        const perPage = layout.perPage;
        if (!perPage) throw new Error('Card does not fit on the selected page size.');
        const totalPages = Math.ceil(rows.length / perPage);
        for (let p = 0; p < totalPages; p++) {
            if (p > 0) doc.addPage();
            for (let i = 0; i < perPage; i++) {
                const dataIdx = p * perPage + i;
                if (dataIdx >= rows.length) break;
                const slot = layout.slots[i];
                const cfg = (cardConfigs && cardConfigs[dataIdx]) || config || CardLayout.DEFAULT_CONFIG;
                placeCard(doc, layout.page, layout.margin + slot.x, layout.margin + slot.y, slot.rotated, rows[dataIdx], map, bg, cfg);
            }
        }

        const buffer = doc.output('arraybuffer');
        self.postMessage({
            ok: true,
            buffer,
            perPage,
            totalPages,
            cardCount: rows.length,
            wastePct: layout.wastePct,
            rotatedCount: layout.rotatedCount,
            pageLabel: layout.page.label,
            hasCmyk: !!bg.cmyk,
        }, [buffer]);
    } catch (err) {
        self.postMessage({ ok: false, error: String((err && err.message) || err) });
    }
};
