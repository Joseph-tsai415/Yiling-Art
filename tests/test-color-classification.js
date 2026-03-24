/**
 * Unit test: Verify all 5,762 Pantone colors are classified correctly.
 *
 * Rules:
 *  1. Every color must belong to exactly one family.
 *  2. A color whose Pantone name contains a family keyword must be
 *     classified into THAT family (name trumps hue).
 *  3. No color should appear in a family whose keywords conflict
 *     with the color's own name (e.g. warm-gray must not appear in orange).
 *  4. All families combined must cover the full library (no orphans).
 *
 * Functions are extracted directly from index.html — no duplication needed.
 */

const fs = require('fs');
const html = fs.readFileSync('./brand-palette-pantone/index.html', 'utf8');

// --- Load Pantone data from JSON ---
const pantoneData = JSON.parse(fs.readFileSync('./brand-palette-pantone/pantone-colors.json', 'utf8'));
const pantoneCoated = pantoneData.coated;
const pantoneUncoated = pantoneData.uncoated;
const allPantone = [...pantoneCoated, ...pantoneUncoated];

// --- Extract functions from index.html (no duplication) ---
function extractFunction(name) {
    // Match: "function name(...) { ... }" with balanced braces
    const re = new RegExp(`function ${name}\\s*\\([^)]*\\)\\s*\\{`);
    const match = re.exec(html);
    if (!match) throw new Error(`Could not find function "${name}" in index.html`);
    let depth = 0, start = match.index;
    for (let i = match.index; i < html.length; i++) {
        if (html[i] === '{') depth++;
        if (html[i] === '}') { depth--; if (depth === 0) return html.slice(start, i + 1); }
    }
    throw new Error(`Could not parse function "${name}" — unbalanced braces`);
}

// Extract and eval each function into this scope
eval(extractFunction('hexToRgb'));
eval(extractFunction('rgbToHsl'));
eval(extractFunction('rgbToLab'));
eval(extractFunction('getColorFamily'));

// Extract colorFamilies object
const cfMatch = html.match(/const colorFamilies\s*=\s*(\{[\s\S]*?\n\s*\});/);
if (!cfMatch) throw new Error('Could not find colorFamilies in index.html');
const colorFamilies = eval('(' + cfMatch[1] + ')');

// --- Build search results per family (same logic as app's searchPantone) ---
function searchFamily(familyKey) {
    const family = colorFamilies[familyKey];
    const otherKeywords = Object.entries(colorFamilies)
        .filter(([k]) => k !== familyKey)
        .flatMap(([, v]) => v.keywords);
    const keywordMatches = [];
    const hueMatches = [];
    allPantone.forEach(p => {
        const name = p.pantone.toLowerCase();
        if (family.keywords.some(kw => name.includes(kw))) {
            keywordMatches.push(p);
        } else if (getColorFamily(p.hex) === familyKey) {
            if (!otherKeywords.some(kw => name.includes(kw))) {
                hueMatches.push(p);
            }
        }
    });
    return [...keywordMatches, ...hueMatches];
}

// ============ TESTS ============

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, message) {
    if (condition) {
        passed++;
    } else {
        failed++;
        failures.push(message);
    }
}

// --- Test 1: Total color count ---
console.log('--- Test 1: Data integrity ---');
assert(allPantone.length === 5772, `Expected 5772 colors, got ${allPantone.length}`);
assert(pantoneCoated.length === 2886, `Expected 2886 coated, got ${pantoneCoated.length}`);
assert(pantoneUncoated.length === 2886, `Expected 2886 uncoated, got ${pantoneUncoated.length}`);

// --- Test 2: Every color has valid hex ---
console.log('--- Test 2: Valid hex values ---');
let invalidHex = 0;
allPantone.forEach(p => {
    if (!/^#[0-9a-f]{6}$/i.test(p.hex)) {
        invalidHex++;
        failures.push(`Invalid hex: ${p.pantone} = ${p.hex}`);
    }
});
assert(invalidHex === 0, `${invalidHex} colors have invalid hex values`);
if (invalidHex === 0) passed++; // count as one test

// --- Test 3: getColorFamily returns a valid family for every color ---
console.log('--- Test 3: Every color gets a family from getColorFamily ---');
const validFamilies = new Set([...Object.keys(colorFamilies)]);
let noFamily = 0;
allPantone.forEach(p => {
    const family = getColorFamily(p.hex);
    if (!validFamilies.has(family)) {
        noFamily++;
        failures.push(`${p.pantone} (${p.hex}) got invalid family: ${family}`);
    }
});
assert(noFamily === 0, `${noFamily} colors returned invalid family from getColorFamily`);

// --- Test 4: Named colors appear in their correct family ---
console.log('--- Test 4: Named colors appear in the correct family ---');
const familyResults = {};
Object.keys(colorFamilies).forEach(key => {
    familyResults[key] = new Set(searchFamily(key).map(p => p.pantone));
});

let misplacedNamed = 0;
allPantone.forEach(p => {
    const name = p.pantone.toLowerCase();
    Object.entries(colorFamilies).forEach(([familyKey, family]) => {
        if (family.keywords.some(kw => name.includes(kw))) {
            if (!familyResults[familyKey].has(p.pantone)) {
                misplacedNamed++;
                failures.push(`NAMED MISS: ${p.pantone} has keyword for "${familyKey}" but is not in that family's results`);
            }
        }
    });
});
assert(misplacedNamed === 0, `${misplacedNamed} named colors missing from their keyword family`);

// --- Test 5: No color with a family keyword in its name appears in a DIFFERENT family ---
console.log('--- Test 5: No cross-family contamination ---');
let contaminated = 0;
Object.entries(familyResults).forEach(([familyKey, members]) => {
    const otherKeywords = Object.entries(colorFamilies)
        .filter(([k]) => k !== familyKey)
        .flatMap(([, v]) => v.keywords);

    members.forEach(pantoneName => {
        const name = pantoneName.toLowerCase();
        const conflictKw = otherKeywords.find(kw => name.includes(kw));
        if (conflictKw) {
            const ownKeywords = colorFamilies[familyKey].keywords;
            const matchesOwn = ownKeywords.some(kw => name.includes(kw));
            if (!matchesOwn) {
                contaminated++;
                failures.push(`CONTAMINATION: "${pantoneName}" in "${familyKey}" results, but name contains "${conflictKw}" (belongs to another family)`);
            }
        }
    });
});
assert(contaminated === 0, `${contaminated} colors appear in wrong family`);

// --- Test 6: Specific regression checks ---
console.log('--- Test 6: Regression checks ---');
// warm-gray must NOT appear in orange
assert(!familyResults['orange'].has('warm-gray-1-u'), 'warm-gray-1-u should NOT be in orange');
assert(!familyResults['orange'].has('warm-gray-1-c'), 'warm-gray-1-c should NOT be in orange');
// warm-gray SHOULD appear in gray
assert(familyResults['gray'].has('warm-gray-1-u'), 'warm-gray-1-u should be in gray');
assert(familyResults['gray'].has('warm-gray-1-c'), 'warm-gray-1-c should be in gray');
// process-blue should be in blue
assert(familyResults['blue'].has('process-blue-u'), 'process-blue-u should be in blue');
assert(familyResults['blue'].has('process-blue-c'), 'process-blue-c should be in blue');
// warm-red should be in red, not orange
assert(familyResults['red'].has('warm-red-c'), 'warm-red-c should be in red');
assert(!familyResults['orange'].has('warm-red-c'), 'warm-red-c should NOT be in orange');
// bright-green should be in green
const hasBrightGreen = [...familyResults['green']].some(n => n.includes('bright-green'));
assert(hasBrightGreen, 'bright-green should be in green');
// LCH-based regressions: pastels correctly classified
assert(getColorFamily('#dbdcbf') === 'yellow', '9602-U (#dbdcbf) should be yellow (C*=15.1, chromatic)');
assert(getColorFamily('#dadcea') === 'white', '7443-C (#dadcea) should be white (C*=7.3, achromatic)');
assert(getColorFamily('#cfe2ee') === 'blue', '9420-U (#cfe2ee) should be blue (C*=8.9, chromatic)');
assert(getColorFamily('#e5d7d6') === 'white', '7604-C (#e5d7d6) should be white (C*=5.1, was red)');
// Very dark tinted colors correctly classified as black
assert(getColorFamily('#19202a') === 'black', '532-C (#19202a) should be black (L*=12, C*=7.7)');
assert(getColorFamily('#302923') === 'black', '4259-C (#302923) should be black (L*=17.2, C*=5.5)');

// --- Test 7: Family sizes are reasonable ---
console.log('--- Test 7: Family size sanity ---');
Object.entries(familyResults).forEach(([key, members]) => {
    const size = members.size;
    assert(size > 0, `Family "${key}" is empty (${size} colors)`);
    console.log(`  ${key.padEnd(8)}: ${String(size).padStart(5)} colors`);
});

// ============ SUMMARY ============
console.log('\n========================================');
if (failed === 0) {
    console.log(`ALL ${passed} TESTS PASSED`);
} else {
    console.log(`${failed} TESTS FAILED (${passed} passed)`);
    console.log('Failures:');
    failures.forEach(f => console.log(`  - ${f}`));
}
console.log('========================================');
process.exit(failed > 0 ? 1 : 0);
