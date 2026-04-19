// ==================== CAPTCHA TOKEN ENCRYPTION ====================
const CAPTCHA_CHARSET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-_";  // 64 chars
const CAPTCHA_SECRET = "AJ9G`0&%I:}RA8#2QQ03]U21Y1!RQc2wGP1M$2_(O>,XG0&4WW25;A43E3%XWi4c";  // 64 chars, real production key

// c0() - Shift generator from official site (replaces old pt() hash function)
// For each output position W (1..len), computes polynomial Σ(seed[i] * W^i) mod 67, then mod 64
function generateShifts(key, len) {
    const seedLen = Math.max(3, key.length);
    const seed = [];
    for (let n = 0; n < seedLen; n++) {
        seed.push((key.charCodeAt(n % key.length) + n) % 67);
    }
    const shifts = [];
    for (let W = 1; W <= len; W++) {
        let e = 0, t = 1;
        for (const r of seed) {
            e = (e + r * t) % 67;
            t = (t * W) % 67;
        }
        shifts.push(e % 64);
    }
    return shifts;
}

// f0() - Official encryption function
export function encryptCaptchaToken(token, key = CAPTCHA_SECRET, skip = 7, encryptLen = 24) {
    if (!token) return token;

    const prefixLen = Math.max(0, Math.min(skip, token.length));
    const remaining = Math.max(0, token.length - prefixLen);
    const actualEncryptLen = Math.max(0, Math.min(encryptLen, remaining));

    if (actualEncryptLen === 0) return token;

    const prefix = token.slice(0, prefixLen);                               // First 7 chars unchanged
    const toEncrypt = token.slice(prefixLen, prefixLen + actualEncryptLen); // Next 24 chars to encrypt
    const suffix = token.slice(prefixLen + actualEncryptLen);               // Rest unchanged

    const shifts = generateShifts(key, toEncrypt.length);

    const encrypted = toEncrypt.split("").map((ch, idx) => {
        const charIdx = CAPTCHA_CHARSET.indexOf(ch);
        if (charIdx === -1) return ch;  // Non-alphanumeric unchanged
        return CAPTCHA_CHARSET[(charIdx + shifts[idx]) % 64];
    }).join("");

    return `${prefix}${encrypted}${suffix}`;
}
