/**
 * Scrape Pantone color data from pantonecolors.net, compare against our
 * database, and generate a patch report.
 *
 * Page format: data-name="110 C" data-hex="#DAAA00"
 */
const https = require('https');
const fs = require('fs');

function fetch(url) {
    return new Promise((resolve, reject) => {
        https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(data));
        }).on('error', reject);
    });
}

function hexToRgb(hex) {
    return { r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16) };
}

function rgbToLab(r, g, b) {
    let rr = r / 255, gg = g / 255, bb = b / 255;
    rr = rr > 0.04045 ? Math.pow((rr + 0.055) / 1.055, 2.4) : rr / 12.92;
    gg = gg > 0.04045 ? Math.pow((gg + 0.055) / 1.055, 2.4) : gg / 12.92;
    bb = bb > 0.04045 ? Math.pow((bb + 0.055) / 1.055, 2.4) : bb / 12.92;
    const x = (rr * 0.4124564 + gg * 0.3575761 + bb * 0.1804375) / 0.95047;
    const y = (rr * 0.2126729 + gg * 0.7151522 + bb * 0.0721750);
    const z = (rr * 0.0193339 + gg * 0.1191920 + bb * 0.9503041) / 1.08883;
    const fx = x > 0.008856 ? Math.pow(x, 1 / 3) : (7.787 * x) + 16 / 116;
    const fy = y > 0.008856 ? Math.pow(y, 1 / 3) : (7.787 * y) + 16 / 116;
    const fz = z > 0.008856 ? Math.pow(z, 1 / 3) : (7.787 * z) + 16 / 116;
    return { l: (116 * fy) - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

function deltaE(hex1, hex2) {
    const rgb1 = hexToRgb(hex1), rgb2 = hexToRgb(hex2);
    const lab1 = rgbToLab(rgb1.r, rgb1.g, rgb1.b), lab2 = rgbToLab(rgb2.r, rgb2.g, rgb2.b);
    const dL = lab1.l - lab2.l, da = lab1.a - lab2.a, db = lab1.b - lab2.b;
    return Math.sqrt(dL * dL + da * da + db * db);
}

async function main() {
    // Step 1: Fetch and extract reference data
    console.log('Fetching pantonecolors.net...');
    const pageHtml = await fetch('https://pantonecolors.net/');

    const refCoated = {}, refUncoated = {};
    const pattern = /data-name="([^"]+)"\s+data-hex="(#[0-9A-Fa-f]{6})"/g;
    let match;
    while ((match = pattern.exec(pageHtml)) !== null) {
        const rawName = match[1].trim();
        const hex = match[2].toLowerCase();
        // Normalize name: "110 C" → "110-c", "Yellow 012 C" → "yellow-012-c"
        const name = rawName.toLowerCase().replace(/\s+/g, '-');
        if (name.endsWith('-c')) refCoated[name] = hex;
        else if (name.endsWith('-u')) refUncoated[name] = hex;
    }

    console.log('Reference coated:', Object.keys(refCoated).length);
    console.log('Reference uncoated:', Object.keys(refUncoated).length);

    // Step 2: Load our database from JSON
    const pantoneData = JSON.parse(fs.readFileSync('./brand-palette-pantone/pantone-colors.json', 'utf8'));
    const ourCoated = pantoneData.coated;
    const ourUncoated = pantoneData.uncoated;
    console.log('Our coated:', ourCoated.length, '| Our uncoated:', ourUncoated.length);

    // Step 3: Compare each set
    function compare(label, ourArray, refMap) {
        const ourMap = {};
        ourArray.forEach(p => ourMap[p.pantone] = p.hex.toLowerCase());

        const updates = [], newColors = [], onlyInOurs = [];
        let same = 0;

        // Check ref against ours
        Object.entries(refMap).forEach(([name, hex]) => {
            if (ourMap[name]) {
                if (ourMap[name] === hex) {
                    same++;
                } else {
                    const dE = deltaE(ourMap[name], hex);
                    updates.push({ name, ours: ourMap[name], ref: hex, dE: +dE.toFixed(2) });
                }
            } else {
                newColors.push({ name, hex });
            }
        });

        // Check ours against ref (find colors only in our DB)
        ourArray.forEach(p => {
            if (!refMap[p.pantone]) onlyInOurs.push(p.pantone);
        });

        console.log('\n=== ' + label + ' ===');
        console.log('Exact match:    ' + same);
        console.log('Hex different:  ' + updates.length);
        console.log('New in ref:     ' + newColors.length);
        console.log('Only in ours:   ' + onlyInOurs.length);

        // Severity breakdown
        if (updates.length > 0) {
            const under1 = updates.filter(u => u.dE < 1).length;
            const under3 = updates.filter(u => u.dE >= 1 && u.dE < 3).length;
            const under5 = updates.filter(u => u.dE >= 3 && u.dE < 5).length;
            const over5 = updates.filter(u => u.dE >= 5).length;
            console.log('\nSeverity of hex differences:');
            console.log('  dE < 1 (imperceptible): ' + under1);
            console.log('  dE 1-3 (subtle):        ' + under3);
            console.log('  dE 3-5 (noticeable):     ' + under5);
            console.log('  dE 5+  (significant):    ' + over5);
        }

        if (newColors.length > 0) {
            console.log('\nNew colors (first 10):');
            newColors.slice(0, 10).forEach(c => console.log('  ' + c.name + ' ' + c.hex));
            if (newColors.length > 10) console.log('  ... and ' + (newColors.length - 10) + ' more');
        }

        if (onlyInOurs.length > 0) {
            console.log('\nOnly in our DB (first 10):');
            onlyInOurs.slice(0, 10).forEach(n => console.log('  ' + n));
            if (onlyInOurs.length > 10) console.log('  ... and ' + (onlyInOurs.length - 10) + ' more');
        }

        return { updates, newColors, onlyInOurs, same };
    }

    const coatedResult = compare('COATED', ourCoated, refCoated);
    const uncoatedResult = compare('UNCOATED', ourUncoated, refUncoated);

    // Step 4: Save full report
    const report = {
        fetchDate: new Date().toISOString(),
        source: 'pantonecolors.net',
        coated: {
            refCount: Object.keys(refCoated).length,
            ourCount: ourCoated.length,
            exactMatch: coatedResult.same,
            updates: coatedResult.updates.sort((a, b) => b.dE - a.dE),
            newColors: coatedResult.newColors,
            onlyInOurs: coatedResult.onlyInOurs
        },
        uncoated: {
            refCount: Object.keys(refUncoated).length,
            ourCount: ourUncoated.length,
            exactMatch: uncoatedResult.same,
            updates: uncoatedResult.updates.sort((a, b) => b.dE - a.dE),
            newColors: uncoatedResult.newColors,
            onlyInOurs: uncoatedResult.onlyInOurs
        }
    };

    fs.writeFileSync('./tests/pantone-patch-report.json', JSON.stringify(report, null, 2));
    console.log('\n=== SUMMARY ===');
    console.log('Coated:   ' + coatedResult.updates.length + ' to update, ' + coatedResult.newColors.length + ' new');
    console.log('Uncoated: ' + uncoatedResult.updates.length + ' to update, ' + uncoatedResult.newColors.length + ' new');
    console.log('Report saved to tests/pantone-patch-report.json');
}

main().catch(console.error);
