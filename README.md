# Brand Color Palette Generator with Pantone Matching

A lightweight, single-file HTML tool for designers to generate harmonious color palettes, find the closest Pantone matches, analyze WCAG accessibility, and export professional PDF reports — all running entirely in the browser with zero installation.

---

## Features

### Color Input & Palette Generation
- **Add custom colors** via hex input or native color picker (up to 8 colors)
- **Quick-start presets**: Corporate, Sunset Warmth, Ocean Breeze, Purple Dreams
- **Popular color swatches** for quick access to commonly used brand colors
- **Mood-based palette generation**: Harmonious, Vibrant, Calm, Professional, Playful, Dramatic
- **Saturation & Brightness sliders** for fine-tuning output before matching
- **Automatic palette variants**: generates Analogous, Triadic, Complementary, Split Complementary, and Monochromatic palettes from your input colors

### Pantone Matching (2,881 Colors)
- **CIEDE2000 perceptual matching** — the industry-standard Delta E algorithm used by color scientists, far more accurate than simple RGB/HSL distance
- **2,881 unique Pantone Formula Guide colors** covering both Coated (C) and Uncoated (U) variants (5,762 total references), sourced from CIE Lab-accurate 2024 data
- **Top 4 closest matches** per color with Delta E score, quality rating, and match confidence percentage
- **Side-by-side visual comparison** — click any Pantone match to see your color vs. the Pantone swatch overlaid
- **Quality scale**: Exact (dE 0–1), Excellent (dE 1–2), Good (dE 2–3.5), Acceptable (dE 3.5–5), Poor (dE 5+)

### Pantone Search
- **Browse and search** the full 2,881-color Pantone library by name or number
- **Filter by type**: All, Coated only, or Uncoated only
- **Instant results** with hex preview swatches

### Accessibility Analysis
- **WCAG 2.1 contrast ratios** calculated against white and black backgrounds
- **Grading**: AAA (7:1+), AA (4.5:1+), AA Large (3:1+), Fail (<3:1)
- **Inter-palette contrast matrix** showing how every pair of your colors performs together

### Export Options
- **Copy HEX** values to clipboard (per palette)
- **Copy CSS** custom properties ready to paste into stylesheets
- **Copy Pantone list** for print production specs
- **PDF Report** — multi-page professional document (see below)

---

## PDF Report

The PDF export generates a comprehensive brand color analysis document using jsPDF (loaded from CDN). You can select which sections to include before generating.

### Sections (all on by default, individually toggleable)

| Section | Contents |
|---------|----------|
| **Cover Page** | Palette band, title, generation date, color count, palette summary chips with RGB/HSL/CMYK values, dynamic table of contents |
| **Color Specifications** | Full color values per swatch — HEX, RGB, HSL, CMYK — with best Pantone match and Delta E |
| **Pantone Matching** | Top 4 Pantone matches per color in a formatted table with swatch, name, C/U badge, hex, Delta E, quality grade, Lab values, and a visual comparison strip |
| **Accessibility & Contrast** | WCAG contrast ratios on white/black, grade badges, WCAG scale legend explaining each level, and inter-palette contrast pairs |
| **Color Application Guide** | Recommended roles (Primary, Secondary, Accent, Background), best color combinations ranked by contrast with usage recommendations, and a suggested palette order strip |
| **Reference Guide** | CIEDE2000 quality scale explanation, Delta E interpretation guide, and production notes |

The page header uses your palette colors in a golden-ratio-inspired proportion bar. Every page includes footer with report title, date, and page numbers.

---

## How to Use

1. **Open** `brand-palette-pantone/index.html` in any modern browser (Chrome, Firefox, Safari, Edge)
2. **Add colors** — type hex codes, use the color picker, or click a preset
3. **Choose a mood** and adjust saturation/brightness if desired
4. **Click "Generate Palettes & Find Pantone"**
5. **Review results** across three tabs: Pantone Match, Palettes, and Search
6. **Export** — click the PDF button, select your sections, and hit Generate PDF

---

## Technical Details

- **Single HTML file** — no build step, no dependencies to install, no server required
- **CDN dependency**: jsPDF loaded from `cdnjs.cloudflare.com` (only needed for PDF export)
- **Color science**: CIE Lab color space, CIEDE2000 (Delta E 2000) formula for perceptual color difference
- **Pantone data**: 2,881 Formula Guide colors with Lab-accurate hex conversions from 2024 reference data, merged with legacy special colors (bright-green, medium-blue, etc.)
- **CMYK values**: Approximated from RGB for quick reference — for print-critical work, always verify against Pantone's official swatch books
- **Dark/Light mode**: Toggle via the sun/moon button in the top-right corner
- **Responsive**: Works on desktop and tablet browsers

---

## For Designers — Practical Workflow

1. **Start with your brand colors** — paste the hex values from your brief or logo
2. **Generate and review Pantone matches** — if Delta E is above 3.5, consider adjusting your color slightly toward the closest Pantone to avoid a visible mismatch in print
3. **Check accessibility** — ensure your primary text color meets at least AA (4.5:1) on your background, AAA (7:1) is preferred
4. **Use the Application Guide** — the role recommendations tell you which color works best for headings, body text, accents, and backgrounds
5. **Export the PDF** — share with print vendors (Pantone references), developers (hex/RGB/CSS values), and clients (visual overview)

---

## File Info

| Property | Value |
|----------|-------|
| File | `brand-palette-pantone/index.html` |
| Size | ~315 KB |
| Pantone Library | 2,881 unique colors (5,762 C+U) |
| Dependencies | jsPDF via CDN (auto-loaded) |
| Browser Support | Chrome 80+, Firefox 78+, Safari 14+, Edge 80+ |

---

*Generated with the Brand Color Palette Generator — a zero-install designer tool for color matching, accessibility, and print production.*
