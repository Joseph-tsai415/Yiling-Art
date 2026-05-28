/*
 * PDF rendering worker — the single source of truth for card layout.
 *
 * Runs off the main thread so building the document (which embeds a ~12 MB CJK
 * font and serializes the whole PDF) never freezes the page. Receives the card
 * data + layout params, fetches the font and background once (cached in worker
 * globals), draws every card with CMYK text, and posts the PDF back as an
 * ArrayBuffer (transferable).
 */
/* global importScripts, self */
importScripts('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js');

const CARD_W_MM = 103;
const CARD_H_MM = 73;

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

const PT_TO_MM = 25.4 / 72;

// Layout zones (mm from top-left of card). The top region (title → english title →
// ingredients) flows downward and is content-aware; the bottom row (allergens +
// price) is fixed. Sizes in pt.
const LAYOUT = {
    titleTopY: 23,             // preferred top of the Chinese title
    englishMinY: 30,           // english title not above this when title is single-line
    bottomY: 60,               // allergens + price top
    ingredientsClearance: 2,   // gap kept between ingredients and the bottom row
    blockGap: 1.2,             // gap between stacked top blocks
    title:       { wrapPct: 0.80, maxSize: 17, minSize: 11, lineHeight: 1.1 },
    englishTitle:{ wrapPct: 0.80, maxSize: 12, minSize: 8,  lineHeight: 1.1 },
    ingredients: { wrapPct: 0.90, maxSize: 9,  minSize: 4.5, lineHeight: 1 },
    allergens:   { maxWidthMm: 70, maxSize: 9, minSize: 6,  lineHeight: 1 },
    price:       { size: 14, lineHeight: 1.1 },
};

const PDF_FONT_NAME = 'ChocolateClassicalSans';
const PDF_FONT_FILE = 'ChocolateClassicalSans-Regular.ttf';

// Cached across messages so re-renders don't re-download.
let fontB64 = null;
let bgPngDataUrl = null;
let bgCmykDataUrl;   // undefined = not probed; null = absent; string = present

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

// ---- Text-fit optimizer ----
// Find the largest font size in [minSize, maxSize] (0.5pt steps) at which `text`,
// word/char-wrapped to wrapWidthMm, fits within maxHeightMm (if given). Honours
// existing newlines. Returns the chosen size, the wrapped lines, and the block
// height in mm.
function fitText(doc, text, opts) {
    const lineHeight = opts.lineHeight || 1.1;
    const minSize = opts.minSize || 4;
    let chosen = minSize;
    let lines = [String(text)];
    for (let size = opts.maxSize; size >= minSize - 1e-9; size -= 0.5) {
        doc.setFontSize(size);
        const wrapped = doc.splitTextToSize(text, opts.wrapWidthMm);
        const heightMm = wrapped.length * size * lineHeight * PT_TO_MM;
        if (!opts.maxHeightMm || heightMm <= opts.maxHeightMm) {
            return { size, lines: wrapped, heightMm, lineHeight };
        }
        chosen = size; lines = wrapped;
    }
    const heightMm = lines.length * chosen * lineHeight * PT_TO_MM;
    return { size: chosen, lines, heightMm, lineHeight };
}

function drawFitted(doc, fit, x, yTopMm, align) {
    doc.setFontSize(fit.size);
    doc.setLineHeightFactor(fit.lineHeight);
    doc.text(fit.lines, x, yTopMm, { align, baseline: 'top' });
}

function drawCard(doc, cardX, cardY, row, map, bg) {
    if (bg.cmyk) {
        doc.addImage(bg.cmyk, 'JPEG', cardX, cardY, CARD_W_MM, CARD_H_MM, undefined, 'NONE');
    } else {
        doc.addImage(bg.png, 'PNG', cardX, cardY, CARD_W_MM, CARD_H_MM, undefined, 'NONE');
    }
    doc.setFont(PDF_FONT_NAME, 'normal');
    doc.setTextColor.apply(doc, CARD_TEXT_CMYK);

    const cx = cardX + CARD_W_MM / 2;
    const L = LAYOUT;

    const title = cellFor(row, map, 'title');
    const englishTitle = cellFor(row, map, 'englishTitle');
    const ingredients = ['cnIngredients', 'enIngredients']
        .map(s => cellFor(row, map, s)).filter(Boolean).join('\n');

    // --- Top region flows downward (content-aware wrap + shrink) ---
    let cursorY = L.titleTopY;
    if (title) {
        const fit = fitText(doc, title, {
            wrapWidthMm: CARD_W_MM * L.title.wrapPct,
            maxSize: L.title.maxSize, minSize: L.title.minSize, lineHeight: L.title.lineHeight,
        });
        drawFitted(doc, fit, cx, cardY + cursorY, 'center');
        cursorY += fit.heightMm;
    }
    if (englishTitle) {
        cursorY = Math.max(cursorY + L.blockGap, L.englishMinY);
        const fit = fitText(doc, englishTitle, {
            wrapWidthMm: CARD_W_MM * L.englishTitle.wrapPct,
            maxSize: L.englishTitle.maxSize, minSize: L.englishTitle.minSize, lineHeight: L.englishTitle.lineHeight,
        });
        drawFitted(doc, fit, cx, cardY + cursorY, 'center');
        cursorY += fit.heightMm;
    }
    if (ingredients) {
        // Zone between the title region bottom and the price/allergen zone top.
        const zTop = cursorY + L.blockGap;                  // title bottom (+small gap)
        const zBot = L.bottomY - L.ingredientsClearance;    // just above the bottom row
        const availH = zBot - zTop;
        if (availH > 2) {
            const fit = fitText(doc, ingredients, {
                wrapWidthMm: CARD_W_MM * L.ingredients.wrapPct,
                maxHeightMm: availH,
                maxSize: L.ingredients.maxSize, minSize: L.ingredients.minSize, lineHeight: L.ingredients.lineHeight,
            });
            // Block centre sits at the golden-section point of the zone (≈38.2% down
            // from the title bottom — slightly above the geometric middle).
            const GOLDEN_FROM_TOP = 1 - 1 / 1.618;   // ≈ 0.382
            const centerY = zTop + (zBot - zTop) * GOLDEN_FROM_TOP;
            let top = centerY - fit.heightMm / 2;
            top = Math.max(zTop, Math.min(top, zBot - fit.heightMm));
            drawFitted(doc, fit, cx, cardY + top, 'center');
        }
    }

    // --- Bottom-left: diet (素別) + allergens (過敏原), shrink to fit its corner ---
    const allergenText = ['diet', 'allergens']
        .map(s => cellFor(row, map, s)).filter(Boolean).join('\n');
    if (allergenText) {
        const fit = fitText(doc, allergenText, {
            wrapWidthMm: L.allergens.maxWidthMm,
            maxHeightMm: CARD_H_MM - L.bottomY - 1,
            maxSize: L.allergens.maxSize, minSize: L.allergens.minSize, lineHeight: L.allergens.lineHeight,
        });
        drawFitted(doc, fit, cardX + 5.5, cardY + L.bottomY, 'left');
    }

    // --- Bottom-right: whole + half/slice price, stacked. A single line sits at
    // bottomY; a second line keeps the block centred on the single-line position,
    // i.e. the whole block moves up half a line. ---
    const priceLines = ['priceWhole', 'priceHalf']
        .map(s => cellFor(row, map, s)).filter(Boolean);
    if (priceLines.length) {
        const lineMm = L.price.size * L.price.lineHeight * PT_TO_MM;
        const top = (L.bottomY + lineMm / 2) - priceLines.length * lineMm / 2;
        doc.setFontSize(L.price.size);
        doc.setLineHeightFactor(L.price.lineHeight);
        // Right-aligned so both rows share the same right edge (5.5mm right margin,
        // symmetric with the allergen block's left margin).
        doc.text(priceLines, cardX + CARD_W_MM - 5.5, cardY + top, { align: 'right', baseline: 'top' });
    }
}

// Draw a card upright at (x,y), or rotated 90° CW into a 73×103 footprint at (x,y).
// Rotation uses a CTM (determinant +1, no mirroring); the card is drawn in its own
// 0,0 origin and the matrix places + rotates it.
function placeCard(doc, page, x, y, rotated, row, map, bg) {
    if (!rotated) {
        drawCard(doc, x, y, row, map, bg);
        return;
    }
    const k = 72 / 25.4;
    const Hpt = page.h * k;
    const e = (x + CARD_H_MM) * k - Hpt;
    const f = Hpt - y * k;
    doc.saveGraphicsState();
    doc.setCurrentTransformationMatrix(new doc.Matrix(0, -1, 1, 0, e, f));
    drawCard(doc, 0, 0, row, map, bg);
    doc.restoreGraphicsState();
}

self.onmessage = async (e) => {
    const { rows, map, pageFormat, margin, gutter, fontUrl, bgUrl, bgCmykUrl } = e.data;
    try {
        if (!fontB64) fontB64 = await fetchAsBase64(fontUrl);
        if (bgPngDataUrl === null) bgPngDataUrl = 'data:image/png;base64,' + await fetchAsBase64(bgUrl);
        if (bgCmykDataUrl === undefined) {
            try { bgCmykDataUrl = 'data:image/jpeg;base64,' + await fetchAsBase64(bgCmykUrl); }
            catch (err) { bgCmykDataUrl = null; }
        }
        const bg = { png: bgPngDataUrl, cmyk: bgCmykDataUrl };

        const layout = computeLayout(pageFormat, margin, gutter);
        const { jsPDF } = self.jspdf;
        const doc = new jsPDF({
            orientation: layout.page.jsOrientation,
            unit: 'mm',
            format: layout.page.jsFormat,
            compress: true,
        });
        doc.addFileToVFS(PDF_FONT_FILE, fontB64);
        doc.addFont(PDF_FONT_FILE, PDF_FONT_NAME, 'normal');

        const perPage = layout.perPage;
        if (!perPage) throw new Error('Card does not fit on the selected page size.');
        const totalPages = Math.ceil(rows.length / perPage);
        for (let p = 0; p < totalPages; p++) {
            if (p > 0) doc.addPage();
            for (let i = 0; i < perPage; i++) {
                const dataIdx = p * perPage + i;
                if (dataIdx >= rows.length) break;
                const slot = layout.slots[i];
                placeCard(doc, layout.page, layout.margin + slot.x, layout.margin + slot.y, slot.rotated, rows[dataIdx], map, bg);
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
