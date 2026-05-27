# Yiling Art

A small collection of zero-install, browser-based tools for designers and print production. Every app is a self-contained folder served from GitHub Pages — no build step, no server, just open the HTML in any modern browser.

**[Live site](https://joseph-tsai415.github.io/Yiling-Art/)**

---

## Apps

| App | Description | Live | Source |
|-----|-------------|------|--------|
| **Brand Color Palette + Pantone** | Generate harmonious palettes, find the closest Pantone matches with CIEDE2000, check WCAG contrast, and export a multi-page PDF report. | [Open](https://joseph-tsai415.github.io/Yiling-Art/brand-palette-pantone/) | [`brand-palette-pantone/`](brand-palette-pantone/) |
| **Product Card Printer** | Upload a CSV of products (title, ingredients, allergens, price…) and lay them out as 103 × 73 mm cards on an A3 or A4 PDF ready for printing. | [Open](https://joseph-tsai415.github.io/Yiling-Art/product-card-printer/) | [`product-card-printer/`](product-card-printer/) |

See each app's own `README.md` (where present) for detailed feature docs.

---

## Repository Layout

```
Yiling-Art/
├── index.html                  ← hub landing page (links to each app)
├── brand-palette-pantone/      ← Pantone matching + palette tool
│   ├── index.html
│   ├── pantone-colors.json
│   ├── pantone-colors.js
│   ├── tests/                  ← Node maintenance scripts for the Pantone dataset
│   └── README.md
├── product-card-printer/       ← CSV → printable product cards
│   └── index.html
└── .github/workflows/          ← GitHub Pages deploy
```

Each app folder is self-contained — adding a new app is just a new folder with its own `index.html`, then a link from the hub `index.html` and a row in the table above.

---

## Versioning

Every app's footer shows the latest git tag. The deploy workflow patches every `index.html` containing `__APP_VERSION__` with the result of `git describe --tags --abbrev=0` (or `dev` if no tag exists). To bump the displayed version, tag a release: `git tag v0.5.0 && git push --tags`.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for branch strategy, PR guidelines, and the per-app branch naming convention.

---

## License

[MIT](LICENSE)
