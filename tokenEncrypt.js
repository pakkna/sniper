// ==================== CAPTCHA TOKEN ENCRYPTION ====================
const CAPTCHA_CHARSET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-_";
const CAPTCHA_SECRET = "2323k4j3202934)(*(*&*(&##KKLJLJKLJ)##LJ754";

/**
 * Generates encryption shifts using the LCG (Linear Congruential Generator) pattern
 * matched from serverAsset.js (function q0)
 * @param {string} key - The secret key string
 * @param {number} len - Number of shifts to generate
 * @returns {number[]} Array of numeric shifts
 */
function generateShifts(key, len) {
    let u = 123456789;
    let s = 1103515245;

    // Seed initialization matching production q0
    for (let f = 0; f < key.length; f++) {
        u = (u + key.charCodeAt(f)) >>> 0;
    }

    const shifts = [];
    for (let f = 0; f < len; f++) {
        // LCG update step
        u = Math.imul(u, s) + 12345 >>> 0;
        
        // Parameter update (s)
        s = ((s + u) >>> 0) | 1;
        
        // Extract shift (identical to production logic: (u >>> 16) % 64)
        shifts.push((u >>> 16) % 64);
    }
    
    return shifts;
}

/**
 * Official encryption logic updated based on latest serverAsset.js
 */
export function encryptCaptchaToken(token, key = CAPTCHA_SECRET, skip = 9, encryptLen = 19) {
    if (!token) return token;

    const prefixLen = Math.max(0, Math.min(skip, token.length));
    const remaining = Math.max(0, token.length - prefixLen);
    const actualEncryptLen = Math.max(0, Math.min(encryptLen, remaining));

    if (actualEncryptLen === 0) return token;

    const prefix = token.slice(0, prefixLen);
    const toEncrypt = token.slice(prefixLen, prefixLen + actualEncryptLen);
    const suffix = token.slice(prefixLen + actualEncryptLen);

    // Using the verified LCG shift generator
    const shifts = generateShifts(key, toEncrypt.length);

    const encrypted = toEncrypt.split("").map((ch, idx) => {
        const charIdx = CAPTCHA_CHARSET.indexOf(ch);
        if (charIdx === -1) return ch;
        // Application of shift with modulo 64
        return CAPTCHA_CHARSET[(charIdx + shifts[idx]) % 64];
    }).join("");

    return `${prefix}${encrypted}${suffix}`;
}
