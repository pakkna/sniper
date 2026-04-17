// ==================== CAPTCHA TOKEN ENCRYPTION ====================
const CAPTCHA_CHARSET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-_";
const CAPTCHA_SECRET = "A&})zlR4I:7}v[LwQ:4Cp8.HY8-6lv_xG_,=frX6O>9,b|RcW>6Iv0~NE0{8rb[d";

// pt() - Hash mixing function from official site
function pt(e, t) {
    let a = Math.imul(1540483477 ^ e, 1821285621 ^ t);
    a ^= a >>> 13;
    a = Math.imul(a, 2246822507);
    a ^= a >>> 16;
    return a >>> 0;
}

// ft() - Official encryption function (exported as 'x' in main bundle)
export function encryptCaptchaToken(token, key = CAPTCHA_SECRET, skip = 9, encryptLen = 19) {
    if (!token) return token;

    const prefixLen = Math.max(0, Math.min(skip, token.length));
    const remaining = Math.max(0, token.length - prefixLen);
    const actualEncryptLen = Math.max(0, Math.min(encryptLen, remaining));

    if (actualEncryptLen === 0) return token;

    const prefix = token.slice(0, prefixLen);                              // First 3 chars unchanged
    const toEncrypt = token.slice(prefixLen, prefixLen + actualEncryptLen); // Next 17 chars to encrypt
    const suffix = token.slice(prefixLen + actualEncryptLen);               // Rest unchanged

    // Generate shifts based on key
    const shifts = (function(keyStr, len) {
        let a = 2538058380 ^ 668265261 * keyStr.length;
        for (let n = 0; n < keyStr.length; n++) {
            a = pt(a, keyStr.charCodeAt(n) ^ 73244475 * n);
        }
        const result = [];
        let r = 19088743 ^ a;
        let s = pt(a, 2654435761);
        for (let n = 0; n < len; n++) {
            r = pt(r + 2654435761 * n, s ^ 2135587861 * n);
            s = pt(s ^ 2246822507 * n, r + 374761393);
            const e = pt(r, s ^ 668265261 * len);
            result.push(e % 64);
        }
        return result;
    })(key, toEncrypt.length);

    const keyLen = key.length || 1;

    // Apply shifts to each character
    const encrypted = toEncrypt.split("").map((ch, idx) => {
        const charIdx = CAPTCHA_CHARSET.indexOf(ch);
        if (charIdx === -1) return ch;  // Non-alphanumeric unchanged
        const shift = (function(shiftVal, pos, kLen) {
            let o = shiftVal + 31 * pos + 17 * kLen;
            o = pt(o ^ 2146121005 * pos, 2221713035 * shiftVal);
            return o % 64;
        })(shifts[idx], idx, keyLen);
        return CAPTCHA_CHARSET[(charIdx + shift + 64) % 64];
    }).join("");

    return `${prefix}${encrypted}${suffix}`;
}
