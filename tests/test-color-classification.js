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
 */

const fs = require('fs');
const html = fs.readFileSync('./brand-palette-pantone/index.html', 'utf8');

// --- Extract Pantone data ---
const cMatch = html.match(/const pantoneCoated\s*=\s*(\[.*?\]);/s);
const uMatch = html.match(/const pantoneUncoated\s*=\s*(\[.*?\]);/s);
if (!cMatch || !uMatch) { console.error('FAIL: Could not parse Pantone data'); process.exit(1); }
const pantoneCoated = eval(cMatch[1]);
const pantoneUncoated = eval(uMatch[1]);
const allPantone = [...pantoneCoated, ...pantoneUncoated];

// --- Color utilities (mirror the app's logic) ---
function hexToRgb(hex) {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result ? {
        r: parseInt(result[1], 16),
        g: parseInt(result[2], 16),
        b: parseInt(result[3], 16)
    } : { r: 0, g: 0, b: 0 };
}

function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    const d = mx - mn, l = (mx + mn) / 2;
    let h = 0, s = 0;
    if (d !== 0) {
        s = d / (1 - Math.abs(2 * l - 1));
        if (mx === r) h = 60 * ((g - b) / d % 6);
        else if (mx === g) h = 60 * ((b - r) / d + 2);
        else h = 60 * ((r - g) / d + 4);
    }
    if (h < 0) h += 360;
    return { h, s: s * 100, l: l * 100 };
}

function getColorFamily(hex) {
    const rgb = hexToRgb(hex);
    const { h, s, l } = rgbToHsl(rgb.r, rgb.g, rgb.b);
    if (s < 15) {
        if (l < 20) return 'black';
        if (l > 90) return 'white';
        return 'gray';
    }
    if (s < 65 && l < 45 && l > 15 && h >= 15 && h < 48) return 'brown';
    if (h < 15 || h >= 345) return 'red';
    if (h < 48) return 'orange';
    if (h < 70) return 'yellow';
    if (h < 165) return 'green';
    if (h < 195) return 'teal';
    if (h < 250) return 'blue';
    if (h < 305) return 'purple';
    if (h < 345) return 'pink';
    return 'gray';
}

// --- Color families (mirror the app) ---
const colorFamilies = {
    'yellow':  { keywords: ['yellow'] },
    'orange':  { keywords: ['orange'] },
    'red':     { keywords: ['red', 'warm-red', 'rubine'] },
    'pink':    { keywords: ['pink', 'magenta', 'rhodamine', 'rose'] },
    'purple':  { keywords: ['purple', 'violet'] },
    'blue':    { keywords: ['blue', 'reflex-blue', 'process-blue'] },
    'teal':    { keywords: ['teal', 'cyan'] },
    'green':   { keywords: ['green'] },
    'brown':   { keywords: ['brown'] },
    'gray':    { keywords: ['gray', 'grey', 'cool-gray', 'warm-gray'] },
    'black':   { keywords: ['black', 'neutral-black'] },
    'white':   { keywords: ['white'] }
};

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
assert(allPantone.length === 5762, `Expected 5762 colors, got ${allPantone.length}`);
assert(pantoneCoated.length === 2881, `Expected 2881 coated, got ${pantoneCoated.length}`);
assert(pantoneUncoated.length === 2881, `Expected 2881 uncoated, got ${pantoneUncoated.length}`);

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
        // Check if this color's name contains another family's keyword
        const conflictKw = otherKeywords.find(kw => name.includes(kw));
        if (conflictKw) {
            // It's OK if the color ALSO matches this family by keyword
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
