// 1. Regular expression patterns and conversion maps
const ARABIC_CHOME_PATTERN = /(\d+)丁目/g;

const NUM_MAP = {
    0: '', 1: '一', 2: '二', 3: '三', 4: '四',
    5: '五', 6: '六', 7: '七', 8: '八', 9: '九'
};

/**
 * Converts Arabic numbers (1-99) to Kanji numbers
 * @param {string} numStr 
 * @returns {string}
 */
function numToKanji(numStr) {
    const num = parseInt(numStr, 10);
    
    if (num === 0) return '〇';
    if (num < 10) return NUM_MAP[num];
    
    const tens = Math.floor(num / 10);
    const ones = num % 10;
    
    const tensStr = tens === 1 ? '十' : `${NUM_MAP[tens]}十`;
    const onesStr = NUM_MAP[ones];
    
    return `${tensStr}${onesStr}`;
}

/**
 * Replaces Arabic number 'chome' with Kanji number 'chome'
 * @param {string} text 
 * @returns {string}
 */
function convertChomeToKanji(text) {
    // JavaScript uses a replacer function within .replace()
    return text.replace(ARABIC_CHOME_PATTERN, (match, p1) => {
        return `${numToKanji(p1)}丁目`;
    });
}

const VARIATIONS = {
    GA: ["ヶ", "ケ", "が", "ガ"],
    NO: ["の", "ノ", "之", "乃"],
    TSU: ["つ", "ツ", "ッ"]
};

// JavaScript requires the 'u' (unicode) flag to match Kanji ranges correctly
const KANJI = "[一-龠]";

const VARIATIONS_PATTERNS = {
    GA: new RegExp(`^(.*${KANJI})(${VARIATIONS.GA.join('|')})(${KANJI}.*)$`, 'u'),
    NO: new RegExp(`^(.*${KANJI})(${VARIATIONS.NO.join('|')})(${KANJI}.*)$`, 'u'),
    TSU: new RegExp(`^(.*${KANJI})(${VARIATIONS.TSU.join('|')})(${KANJI}.*)$`, 'u'),
};

/**
 * Generates alternative spellings for particles like 'ga', 'no', 'tsu'
 * @param {string} name 
 * @returns {string[]}
 */
function generateNameVariations(name) {
    const names = [];

    for (const key of Object.keys(VARIATIONS_PATTERNS)) {
        const pattern = VARIATIONS_PATTERNS[key];
        const match = name.match(pattern);
        
        if (match) {
            const prefix = match[1];
            const suffix = match[3];
            
            for (const varChar of VARIATIONS[key]) {
                const newName = `${prefix}${varChar}${suffix}`;
                if (newName !== name) {
                    names.push(newName);
                }
            }
        }
    }
    return names;
}

/**
 * Main function to get all name variations
 * @param {string} name 
 * @returns {string[]}
 */
export function getNameVariations(name) {
    // NFKC normalization matches Python's unicodedata.normalize
    const originalName = name.normalize("NFKC");
    let currentName = originalName;

    const variations = new Set();

    // 1. Chome conversion
    const chomeConverted = convertChomeToKanji(currentName);
    if (chomeConverted !== currentName) {
        variations.add(chomeConverted);
        currentName = chomeConverted; // Pass modified string to next step
    }

    // 2. Particle variation conversion
    const nameVariations = generateNameVariations(currentName);
    for (const variant of nameVariations) {
        variations.add(variant);
    }

    // Convert Set back to Array and insert original name at index 0
    const names = Array.from(variations);
    names.unshift(originalName);
    
    return names;
}

// --- Execution Example ---
// const exampleText = "鳩ヶ谷緑町10丁目";
// console.log(getNameVariations(exampleText));
// Output: [ '鳩ヶ谷緑町10丁目', '鳩ヶ谷緑町十丁目', '鳩ケ谷緑町十丁目', '鳩が谷緑町十丁目', '鳩ガ谷緑町十丁目' ]
