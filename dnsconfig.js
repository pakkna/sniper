import dns from 'node:dns';

// Set to true to hit the main url with no specific ip.
// If false, then the fixed ip from dnsMap is used.
export const directApi = false; 

export const dnsMap = {
    "api.ivacbd.com": "3.108.183.28"
};

export const customLookup = (hostname, options, callback) => {
    if (!directApi && dnsMap[hostname]) {
        // Resolve to the fixed IP
        return callback(null, dnsMap[hostname], 4);
    }
    return dns.lookup(hostname, options, callback);
};
