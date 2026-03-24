/**
 * Patch pantone-colors.json:
 * 1. Update 2,331 coated hex values from pantonecolors.net reference
 * 2. Add 5 new coated colors + their uncoated counterparts
 * 3. Generate a changelog with old → new for every change
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

async function main() {
    const patchDate = new Date().toISOString().split('T')[0];

    // Step 1: Load our JSON
    const data = JSON.parse(fs.readFileSync('./brand-palette-pantone/pantone-colors.json', 'utf8'));
    console.log('Loaded — Coated:', data.coated.length, '| Uncoated:', data.uncoated.length);

    // Step 2: Fetch reference data from pantonecolors.net
    console.log('Fetching pantonecolors.net...');
    const pageHtml = await fetch('https://pantonecolors.net/');
    const refCoated = {};
    const pattern = /data-name="([^"]+)"\s+data-hex="(#[0-9A-Fa-f]{6})"/g;
    let match;
    while ((match = pattern.exec(pageHtml)) !== null) {
        const name = match[1].trim().toLowerCase().replace(/\s+/g, '-');
        const hex = match[2].toLowerCase();
        if (name.endsWith('-c')) refCoated[name] = hex;
    }
    console.log('Reference coated colors:', Object.keys(refCoated).length);

    // Step 3: Build coated index
    const coatedIndex = {};
    data.coated.forEach((p, i) => coatedIndex[p.pantone] = i);
    const uncoatedIndex = {};
    data.uncoated.forEach((p, i) => uncoatedIndex[p.pantone] = i);

    // Step 4: Patch existing coated hex values
    const changelog = [];
    let updatedCount = 0;

    Object.entries(refCoated).forEach(([name, refHex]) => {
        if (coatedIndex[name] !== undefined) {
            const idx = coatedIndex[name];
            const oldHex = data.coated[idx].hex.toLowerCase();
            if (oldHex !== refHex) {
                changelog.push({
                    type: 'update',
                    name,
                    variant: 'coated',
                    oldHex: oldHex,
                    newHex: refHex,
                    date: patchDate
                });
                data.coated[idx].hex = refHex;
                updatedCount++;
            }
        }
    });
    console.log('Coated hex values updated:', updatedCount);

    // Step 5: Add 5 new colors (coated + uncoated)
    const newColors = [
        { c: { pantone: 'orange-016-c', hex: '#ff5600' }, u: { pantone: 'orange-016-u', hex: '#ff6740' } },
        { c: { pantone: 'yellow-py12-c', hex: '#f6dd00' }, u: { pantone: 'yellow-py12-u', hex: '#ffe200' } },
        { c: { pantone: 'purple-v2-c', hex: '#b041b1' },  u: { pantone: 'purple-v2-u', hex: '#b05daf' } },
        { c: { pantone: 'violet-v2-c', hex: '#3d0385' },  u: { pantone: 'violet-v2-u', hex: '#6c499e' } },
        { c: { pantone: 'real-purple-c', hex: '#c92fbf' }, u: { pantone: 'real-purple-u', hex: '#d159c6' } },
    ];

    let addedCount = 0;
    newColors.forEach(({ c, u }) => {
        if (!coatedIndex.hasOwnProperty(c.pantone)) {
            data.coated.push(c);
            changelog.push({ type: 'add', name: c.pantone, variant: 'coated', newHex: c.hex, date: patchDate });
            addedCount++;
        }
        if (!uncoatedIndex.hasOwnProperty(u.pantone)) {
            data.uncoated.push(u);
            changelog.push({ type: 'add', name: u.pantone, variant: 'uncoated', newHex: u.hex, date: patchDate });
            addedCount++;
        }
    });
    console.log('New colors added:', addedCount);

    // Step 6: Write updated JSON
    fs.writeFileSync('./brand-palette-pantone/pantone-colors.json', JSON.stringify(data, null, 2));
    console.log('\nUpdated pantone-colors.json');
    console.log('New totals — Coated:', data.coated.length, '| Uncoated:', data.uncoated.length);

    // Step 7: Write changelog
    const changelogContent = {
        patchDate,
        source: 'pantonecolors.net + web research (qtccolor.com, encycolorpedia.com)',
        summary: {
            coatedHexUpdated: updatedCount,
            newColorsAdded: addedCount,
            totalChanges: changelog.length
        },
        changes: changelog
    };
    fs.writeFileSync('./tests/pantone-patch-changelog.json', JSON.stringify(changelogContent, null, 2));
    console.log('Changelog saved to tests/pantone-patch-changelog.json (' + changelog.length + ' entries)');

    // Step 8: Print summary of biggest changes
    const updates = changelog.filter(c => c.type === 'update').sort((a, b) => {
        // Sort by visual difference (simple RGB distance)
        function hexDist(h1, h2) {
            const r1 = parseInt(h1.slice(1,3),16), g1 = parseInt(h1.slice(3,5),16), b1 = parseInt(h1.slice(5,7),16);
            const r2 = parseInt(h2.slice(1,3),16), g2 = parseInt(h2.slice(3,5),16), b2 = parseInt(h2.slice(5,7),16);
            return Math.sqrt((r1-r2)**2 + (g1-g2)**2 + (b1-b2)**2);
        }
        return hexDist(b.oldHex, b.newHex) - hexDist(a.oldHex, a.newHex);
    });

    console.log('\n=== TOP 10 BIGGEST HEX CHANGES ===');
    updates.slice(0, 10).forEach(c => {
        console.log(c.name.padEnd(20) + c.oldHex + ' → ' + c.newHex);
    });

    console.log('\n=== NEW COLORS ADDED ===');
    changelog.filter(c => c.type === 'add').forEach(c => {
        console.log(c.name.padEnd(20) + c.newHex + ' (' + c.variant + ')');
    });
}

main().catch(console.error);
