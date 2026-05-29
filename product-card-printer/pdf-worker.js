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
importScripts('card-layout.js?v=20260529a');   // shared config + layout algorithm (keep ?v= in sync with index.html)

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
// by the selected cards; each is embedded under its key as a 'normal' jsPDF font.
// The background is supplied as a ready data URL (fetched once on the main thread),
// so the worker never touches S3 and there's no CORS to worry about here.
let fontB64Map = {};
let embeddedKeys = new Set();
let defaultFontKey = null;

async function fetchAsBase64(url) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(url + ' → HTTP ' + resp.status);
    const buf = await resp.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + chunk, bytes.length)));
    }
    return btoa(binary);
}

function unescapeNewlines(s) {
    return String(s || '').replace(/\\n/g, '\n');
}

function cellFor(row, map, fieldId) {
    const idx = map[fieldId];
    if (idx === undefined || idx < 0 || idx >= row.length) return '';
    return unescapeNewlines(row[idx]);
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

    const fields = {
        title: cellFor(row, map, 'title'),
        englishTitle: cellFor(row, map, 'englishTitle'),
        ingredients: ['cnIngredients', 'enIngredients'].map(s => cellFor(row, map, s)).filter(Boolean).join('\n'),
        allergens: ['diet', 'allergens'].map(s => cellFor(row, map, s)).filter(Boolean).join('\n'),
        priceLines: ['priceWhole', 'priceHalf'].map(s => cellFor(row, map, s)).filter(Boolean),
    };
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
        doc.text(it.lines, cardX + it.x, cardY + it.y, { align: it.align, baseline: 'top' });
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

self.onmessage = async (e) => {
    const { rows, map, pageFormat, margin, gutter, fontUrl, fontFiles, defaultKey, bgDataUrl, bgCmykDataUrl, config, cardConfigs } = e.data;
    try {
        // { fontKey: ttfUrl } for every face used by the selected cards. Older callers
        // that only send a single fontUrl still work via the default key.
        const faces = fontFiles || {};
        defaultFontKey = defaultKey || CardLayout.fontKey(CardLayout.DEFAULT_FONT, CardLayout.DEFAULT_WEIGHT);
        if (!faces[defaultFontKey] && fontUrl) faces[defaultFontKey] = fontUrl;
        for (const key in faces) {
            if (!fontB64Map[key]) fontB64Map[key] = await fetchAsBase64(faces[key]);
        }
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
            const file = key + '.ttf';
            doc.addFileToVFS(file, fontB64Map[key]);
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
