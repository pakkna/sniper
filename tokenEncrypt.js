// ==================== CAPTCHA TOKEN ENCRYPTION ====================
const CAPTCHA_CHARSET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-_";  // 64 chars
const CAPTCHA_SECRET = "A.reU8WIId;h4KO-Q3oEKvJ1Ys[_05J2G~xkA0COOj<n6QU{W5uKQbP3Ey|[27P4";  // 64 chars, real production key

// generateShifts - NEW LCG (Linear Congruential Generator) Logic found in serverAsset.js (B0)
function generateShifts(key, len) {
    let i = 123456789;
    let c = 1103515245;

    // Seed initialization
    for (let W = 0; W < key.length; W++) {
        i = (i + key.charCodeAt(W)) >>> 0;
    }

    const shifts = [];
    for (let W = 0; W < len; W++) {
        // LCG Step 1
        i = (Math.imul(i, c) + 12345) >>> 0;
        
        // LCG Step 2
        c = ((c + i) >>> 0) | 1;
        
        // Extracted shift value
        shifts.push((i >>> 16) % 64);
    }
    
    return shifts;
}

// encryptCaptchaToken - Official encryption function (j0 in serverAsset.js)
export function encryptCaptchaToken(token, key = CAPTCHA_SECRET, skip = 10, encryptLen = 25) {
    if (!token) return token;

    const prefixLen = Math.max(0, Math.min(skip, token.length));
    const remaining = Math.max(0, token.length - prefixLen);
    const actualEncryptLen = Math.max(0, Math.min(encryptLen, remaining));

    if (actualEncryptLen === 0) return token;

    const prefix = token.slice(0, prefixLen);                               // First characters unchanged
    const toEncrypt = token.slice(prefixLen, prefixLen + actualEncryptLen); // Characters to encrypt
    const suffix = token.slice(prefixLen + actualEncryptLen);               // Rest unchanged

    const shifts = generateShifts(key, toEncrypt.length);

    const encrypted = toEncrypt.split("").map((ch, idx) => {
        const charIdx = CAPTCHA_CHARSET.indexOf(ch);
        if (charIdx === -1) return ch;  // Non-alphanumeric unchanged
        return CAPTCHA_CHARSET[(charIdx + shifts[idx]) % 64];
    }).join("");

    return `${prefix}${encrypted}${suffix}`;
}