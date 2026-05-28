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
    'a4-portrait':  { w: 210, h: 297, jsOrientation: 'p', jsFormat: 'a4' },
    'a4-landscape': { w: 297, h: 210, jsOrientation: 'l', jsFormat: 'a4' },
    'a3-portrait':  { w: 297, h: 420, jsOrientation: 'p', jsFormat: 'a3' },
    'a3-landscape': { w: 420, h: 297, jsOrientation: 'l', jsFormat: 'a3' },
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

function computeLayout(pageFormat, margin, gutter) {
    const page = PAGES[pageFormat];
    margin = Math.max(0, margin || 0);
    gutter = Math.max(0, gutter || 0);
    const usableW = page.w - margin * 2;
    const usableH = page.h - margin * 2;
    const cols = Math.max(1, Math.floor((usableW + gutter) / (CARD_W_MM + gutter)));
    const rows = Math.max(1, Math.floor((usableH + gutter) / (CARD_H_MM + gutter)));
    const perPage = cols * rows;
    const blockW = cols * CARD_W_MM + (cols - 1) * gutter;
    const blockH = rows * CARD_H_MM + (rows - 1) * gutter;
    const offsetX = (page.w - blockW) / 2;
    const offsetY = (page.h - blockH) / 2;
    return { page, margin, gutter, cols, rows, perPage, offsetX, offsetY };
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

        const totalPages = Math.ceil(rows.length / layout.perPage);
        for (let p = 0; p < totalPages; p++) {
            if (p > 0) doc.addPage();
            for (let i = 0; i < layout.perPage; i++) {
                const dataIdx = p * layout.perPage + i;
                if (dataIdx >= rows.length) break;
                const col = i % layout.cols;
                const rowIdx = Math.floor(i / layout.cols);
                const x = layout.offsetX + col * (CARD_W_MM + layout.gutter);
                const y = layout.offsetY + rowIdx * (CARD_H_MM + layout.gutter);
                drawCard(doc, x, y, rows[dataIdx], map, bg);
            }
        }

        const buffer = doc.output('arraybuffer');
        self.postMessage({
            ok: true,
            buffer,
            cols: layout.cols,
            rows: layout.rows,
            totalPages,
            cardCount: rows.length,
            hasCmyk: !!bg.cmyk,
        }, [buffer]);
    } catch (err) {
        self.postMessage({ ok: false, error: String((err && err.message) || err) });
    }
};
