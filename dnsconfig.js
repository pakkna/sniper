//import dns from 'node:dns';

// Set to true to hit the main url with no specific ip.
// If false, then the fixed ip from dnsMap is used.
export let directApi = false; 
export const setDirectApi = (val) => { directApi = val; };

export const dnsMap = {
    "api.ivacbd.com": [
        "65.0.229.15",
        "35.154.147.88",
        "35.154.173.251"
    ]
};

// export const customLookup = (hostname, options, callback) => {
//     if (!directApi && dnsMap[hostname]) {
//         const ipOrArray = dnsMap[hostname];
//         const fixedIp = Array.isArray(ipOrArray) ? ipOrArray[Math.floor(Math.random() * ipOrArray.length)] : ipOrArray;
//         return callback(null, fixedIp, 4);
//     }
//     return dns.lookup(hostname, options, callback);
// };
