import { execSync, spawn } from "child_process";
import express from "express";
import fs from "fs";
import { gotScraping } from "got-scraping";
import { createServer, Agent as HttpAgent } from "http";
import { Agent as HttpsAgent } from "https";
import path from "path";
import { Server } from "socket.io";
import { fileURLToPath } from "url";
import { directApi, dnsMap, setDirectApi } from "./dnsconfig.js";
import { encryptCaptchaToken } from "./tokenEncrypt.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

let panelConfig = { 
    user: "admin", 
    pass: "admin123", 
    ip: "0.0.0.0", 
    port: 5000, 
    main_ip: "", 
    additional_ips: [], 
    saved_mobile: "", 
    saved_email: "", 
    saved_password: "", 
    capInfo: { type: null, key: null },
    profiles: [] 
};
try {
    const cf = fs.readFileSync(path.join(__dirname, "config.json"), "utf8");
    panelConfig = { ...panelConfig, ...JSON.parse(cf) };
} catch (e) {
    fs.writeFileSync(path.join(__dirname, "config.json"), JSON.stringify(panelConfig, null, 2));
}

// ==========================================
// MULTI-PROFILE STATE ENGINE
// ==========================================
const profileStates = new Map();

// Initialize profiles from config
if (panelConfig.profiles && Array.isArray(panelConfig.profiles)) {
    panelConfig.profiles.forEach(p => {
        profileStates.set(p.id, createProfileState(p));
    });
}

function createProfileState(data) {
    const id = data.id || Math.random().toString(36).substring(2, 10);
    return {
        id,
        taskName: data.taskName || "Task-" + id,
        email: data.email || "",
        mobile: data.mobile || "",
        password: data.password || "",
        authStorage: {
            state: { 
                token: null, userId: null, expiresAt: 899,
                isAuthenticated: false, isVerified: false,
                requestId: null, phone: data.mobile || null, 
                password: data.password || null, otpSentAt: null 
            },
            version: 0
        },
        workerCounts: { sendOtp: 0, verifyOtp: 0, reserveSlot: 0, payNow: 0 },
        flags: {
            isOtpVerifyAggressive: false,
            isReserveStarted: false,
            isReserveOtpSend: false,
            globalOtpVerified: false,
            pollingOtp: false,
            lastGetOtp: []
        },
        PRE_FETCHED_OTP: null,
        status: { msg: "Idle", type: "info", time: null },
        steps: { signin: 'idle', verify: 'idle', reserve: 'idle', pay: 'idle' },
        verifiedAt: null,
        reservedAt: null,
        otpWaitUntil: null,
        paymentUrl: null
    };
}

function resetProfileState(pState) {
    const fresh = createProfileState({
        id: pState.id,
        taskName: pState.taskName,
        email: pState.email,
        mobile: pState.mobile,
        password: pState.password
    });
    Object.assign(pState, fresh);
    return pState;
}

function logProfile(pState, msg, color = "#fff", json = null) {
    const now = new Date();
    const bdNow = new Date(now.getTime() + 6 * 60 * 60 * 1000);
    const timeStr = `${String(bdNow.getUTCHours()).padStart(2, "0")}:${String(bdNow.getUTCMinutes()).padStart(2, "0")}:${String(bdNow.getUTCSeconds()).padStart(2, "0")}`;
    const logMsg = `[${timeStr}] ${msg}`;
    
    // 1. File Logging
    try {
        const logsDir = path.join(__dirname, "logs");
        if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir);
        const logFile = path.join(logsDir, `${pState.id}.log`);
        // Use asynchronous append to prevent blocking the event loop under heavy load
        fs.appendFile(logFile, logMsg + "\n", () => {});
    } catch (e) {}

    // 2. Broadcast to UI
    const type = (color === "#dc2626" || color === "#ef4444") ? "error" : (color === "#16a34a" || color === "#10b981" ? "success" : "info");
    
    io.emit("profile-status", {
        profileId: pState.id,
        msg,
        type,
        time: timeStr,
        steps: pState.steps,
        verifiedAt: pState.verifiedAt,
        reservedAt: pState.reservedAt,
        paymentUrl: pState.paymentUrl,
        foundOtp: json?.foundOtp,
        clearOtp: json?.clearOtp
    });

    io.emit("profile-log", {
        profileId: pState.id,
        msg,
        color,
        time: timeStr,
        json
    });
    
    // 3. UI Row Update
    pState.status.msg = msg;
    pState.status.time = timeStr;
    pState.status.type = type;

    if (pState.paymentUrl) {
        io.emit("payment-link", {
            profileId: pState.id,
            url: pState.paymentUrl
        });
    }
}

// SECURE SESSION CONFIG
const SESSION_SECRET = "30c4e9e9e8104bfe1458348b69037995d8ed7d1fc407bfaab359dd59b6838862";
let currentSessionToken = null;
let sessionExpiry = 0;

function generateSessionToken() {
    const token = Math.random().toString(36).substring(2) + Date.now().toString(36);
    const expiry = Date.now() + (5 * 60 * 60 * 1000); // 5 Hours
    
    panelConfig.sessionToken = token;
    panelConfig.sessionExpiry = expiry;
    
    // Persist to config so sessions survive server restarts/PM2 updates
    try {
        fs.writeFileSync(path.join(__dirname, "config.json"), JSON.stringify(panelConfig, null, 2));
    } catch (e) {}
    
    return token;
}

let GLOBAL_RETRY_SETTINGS = {};
let currentProxyState = { activeMode: "native", proxies: [] };

function getNetworkOpts(workerId = null) {
    const opts = {
        https: { rejectUnauthorized: false }
    };

    const localAddress = getLocalAddress(workerId);
    if (localAddress) {
        opts.localAddress = localAddress;
    }

    return opts;
}

function getLocalAddress(workerId = null) {
    if (!currentProxyState || currentProxyState.activeMode !== "private") return undefined;
    if (!panelConfig || !panelConfig.main_ip) return undefined;
    
    const allIps = [panelConfig.main_ip, ...(panelConfig.additional_ips || [])];
    
    if (workerId === null || workerId === undefined) {
        return allIps[0];
    }
    
    const index = (workerId - 1) % allIps.length;
    return allIps[index];
}

function getProxyUrl(taskName = "Request", workerId = null, silent = false) {
    if (!currentProxyState || currentProxyState.activeMode === "native" || currentProxyState.activeMode === "private") return undefined;
    
    let selectedProxy = null;
    const proxies = currentProxyState.proxies || [];
    if (proxies.length === 0) return undefined;

    if (currentProxyState.activeMode === "random") {
        if (workerId !== null && workerId !== undefined) {
             if (workerId === 1) return undefined;
             const index = workerId - 2;
             if (index < 0 || index >= proxies.length) {
                 return undefined; // Native fallback if not enough proxies
             }
             selectedProxy = proxies[index];
        } else {
             selectedProxy = proxies[Math.floor(Math.random() * proxies.length)];
        }
    } else {
        selectedProxy = proxies.find(p => p.title === currentProxyState.activeMode);
    }
    
    if (!selectedProxy) return undefined;
    
    if (!silent) logSolver(`[PROXY] ${taskName}: ${selectedProxy.title}`, "#eab308");
    
    const credentials = (selectedProxy.user && selectedProxy.pass) ? `${selectedProxy.user}:${selectedProxy.pass}@` : "";
    return `http://${credentials}${selectedProxy.host}:${selectedProxy.port}`;
}

function getNetworkTitle(workerId = null) {
    if (!currentProxyState || currentProxyState.activeMode === "native") return "Native";
    if (currentProxyState.activeMode === "private") {
        if (!panelConfig || !panelConfig.main_ip) return "Fallback";
        
        const allIps = [panelConfig.main_ip, ...(panelConfig.additional_ips || [])];
        if (workerId === null || workerId === undefined) {
            return "M-IP";
        }
        
        const index = (workerId - 1) % allIps.length;
        if (index === 0) return "M-IP";
        return `EX-${index}`;
    }
    const proxies = currentProxyState.proxies || [];
    if (proxies.length === 0) return "Native";
    
    let selectedProxy = null;
    if (currentProxyState.activeMode === "random") {
        if (workerId !== null && workerId !== undefined) {
            if (workerId === 1) return "Native";
            const index = workerId - 2;
            if (index < 0 || index >= proxies.length) return "Native";
            selectedProxy = proxies[index];
        }
    } else {
        selectedProxy = proxies.find(p => p.title === currentProxyState.activeMode);
    }
    return selectedProxy ? selectedProxy.title : "Native";
}

const workerNetworkClients = new Map();
const tlsSessionCache = new Map();

function getGotClient(taskName, workerId) {
    const activeMode = currentProxyState?.activeMode || 'native';
    const allIps = [panelConfig.main_ip, ...(panelConfig.additional_ips || [])];
    const isMultiIp = (activeMode === 'private' && allIps.length > 1);
    const isRandom = (activeMode === 'random');

    let key;
    let effectiveWorkerId = workerId;

    if (isRandom || isMultiIp) {
        // Proxy rotation modes: per-worker isolated client (unchanged)
        const pUrl = getProxyUrl(taskName, workerId, true);
        key = `${activeMode}-${workerId}-${pUrl || 'none'}`;
    } else {
        // Native / single-proxy / dns-map modes:
        // Per-worker persistent HTTP/1.1 — each worker = own TCP conn = own ALB queue slot
        const pUrl = getProxyUrl(taskName, null, true);
        const wId = (workerId !== null && workerId !== undefined) ? workerId : 'shared';
        key = `${activeMode}-w${wId}-${pUrl || 'none'}`;
        effectiveWorkerId = (workerId !== null && workerId !== undefined) ? workerId : 1;
    }

    const proxyUrl = getProxyUrl(taskName, effectiveWorkerId, true);
    const netOpts = getNetworkOpts(effectiveWorkerId);

    if (!workerNetworkClients.has(key)) {
        // DNS override: when directApi=false, bypass Cloudflare → hit ALB IP directly
        const useDnsOverride = !directApi
            && Array.isArray(dnsMap["api.ivacbd.com"])
            && dnsMap["api.ivacbd.com"].length > 0;
        const targetIp = useDnsOverride ? dnsMap["api.ivacbd.com"][0] : null; // Always first IP

        const agentOpts = {
            keepAlive: true,        // Reuse warm TCP connections on every retry
            keepAliveMsecs: 30000,  // Ping idle sockets every 30s to stay warm
            maxSockets: 1,          // Strict: 1 connection per worker = 1 ALB slot
            maxFreeSockets: 1,      // Keep 1 idle socket ready
            scheduling: 'fifo',     // Fair ordering
            rejectUnauthorized: false
        };

        const client = gotScraping.extend({
            http2: false,           // HTTP/1.1: each worker = own independent ALB connection slot
            throwHttpErrors: false,
            retry: { limit: 0 },
            timeout: {
                connect: 10000,      // Fail fast if TCP won't connect
                secureConnect: 15000, // Fail fast if TLS stalls
                socket: 60000,      // Drop dead idle sockets
                send: 60000,        // Time to send request body
                request: 180000,    // NEVER kill a pending/queued request
                response: 180000    // Wait for first response byte up to 3 min
            },
            proxyUrl: proxyUrl,
            agent: {
                http: new HttpAgent(agentOpts),
                https: new HttpsAgent(agentOpts)
            },
            hooks: {
                beforeRequest: [
                    (options) => {
                        // Override hostname → ALB IP, keep SNI as original host
                        if (useDnsOverride && targetIp) {
                            const originalHostname = options.url.hostname;
                            if (dnsMap[originalHostname]) {
                                options.url.hostname = targetIp;
                                options.headers['host'] = originalHostname;
                                if (!options.https) options.https = {};
                                options.https.servername = originalHostname; // Critical SNI
                                options.https.rejectUnauthorized = false;
                            }
                        }
                        // TLS session reuse: retries get instant TLS resumption
                        const cacheHost = "api.ivacbd.com";
                        if (tlsSessionCache.has(cacheHost)) {
                            if (!options.https) options.https = {};
                            options.https.tlsOptions = { ...options.https.tlsOptions, session: tlsSessionCache.get(cacheHost) };
                        }
                    }
                ],
                afterResponse: [
                    (response) => {
                        // Cache TLS session so all retries skip full handshake
                        const cacheHost = "api.ivacbd.com";
                        if (response.request?.socket?.getSession) {
                            const session = response.request.socket.getSession();
                            if (session) tlsSessionCache.set(cacheHost, session);
                        }
                        return response;
                    }
                ],
                beforeError: [
                    (error) => {
                        // Clear session on connection error → force fresh TLS next time
                        tlsSessionCache.delete("api.ivacbd.com");
                        return error;
                    }
                ]
            },
            ...netOpts
        });
        workerNetworkClients.set(key, client);
    }
    return workerNetworkClients.get(key);
}

function clearWorkerClient(taskName, workerId) {
    const activeMode = currentProxyState?.activeMode || 'native';
    const allIps = [panelConfig.main_ip, ...(panelConfig.additional_ips || [])];
    const isMultiIp = (activeMode === 'private' && allIps.length > 1);
    const isRandom = (activeMode === 'random');

    let key;
    if (isRandom || isMultiIp) {
        const pUrl = getProxyUrl(taskName, workerId, true);
        key = `${activeMode}-${workerId}-${pUrl || 'none'}`;
    } else {
        const pUrl = getProxyUrl(taskName, null, true);
        const wId = (workerId !== null && workerId !== undefined) ? workerId : 'shared';
        key = `${activeMode}-w${wId}-${pUrl || 'none'}`;
    }

    if (workerNetworkClients.has(key)) {
        workerNetworkClients.delete(key);
        return true;
    }
    return false;
}

function clearTlsSession(host) {
    if (tlsSessionCache.has(host)) {
        tlsSessionCache.delete(host);
        return true;
    }
    return false;
}



function reloadDnsConfig() {
    try {
        const content = fs.readFileSync(path.join(__dirname, "dnsconfig.js"), "utf8");
        const match = content.match(/"api\.ivacbd\.com"\s*:\s*\[(.*?)\]/s);
        if (match) {
            const ips = match[1].split(',').map(s => s.replace(/["'\s]/g, '')).filter(s => s);
            if (ips.length > 0) dnsMap["api.ivacbd.com"] = ips;
        }
    } catch(e) {
        console.error("Failed to reload dnsconfig", e);
    }
}

// ==========================================
// STATE ENGINE
// ==========================================
const RootUrl = "https://api.ivacbd.com";

const showStatus = (msg, type = "info") => io.emit("status", { msg, type });
const logSolver = (msg, color = "#fff", json = null) => {
    io.emit("solver-log", { msg, color, json, time: new Date().toLocaleTimeString() });
};
const finishBtn = (id, text, stepStatus, activeStep) => io.emit("btn-reset", { id, text, stepStatus, activeStep: activeStep || id });

// Node.js Task Manager mimicking their logic
const TaskManager = {
    tasks: {},
    start(taskName) {
        if (!this.tasks[taskName]) this.tasks[taskName] = { controllers: new Set(), timeouts: new Set() };
        const controller = new AbortController();
        this.tasks[taskName].controllers.add(controller);
        return controller;
    },
    removeController(taskName, controller) {
        this.tasks[taskName]?.controllers.delete(controller);
    },
    stopTask(taskName) {
        const t = this.tasks[taskName];
        if (!t) return;
        t.controllers.forEach(ctrl => ctrl.abort());
        t.controllers.clear();
        t.timeouts.forEach(id => clearTimeout(id));
        t.timeouts.clear();
    },
    stopAll() {
        Object.keys(this.tasks).forEach(taskName => this.stopTask(taskName));
    },
    setTimeout(taskName, fn, delay) {
        if (!this.tasks[taskName]) this.tasks[taskName] = { controllers: new Set(), timeouts: new Set() };
        const id = setTimeout(() => {
            this.tasks[taskName].timeouts.delete(id);
            fn();
        }, delay);
        this.tasks[taskName].timeouts.add(id);
        return id;
    }
};// SHARED ACROSS ALL PROFILES
let global403PauseUntil = 0;
let solversInProgress = 0;
let preSolvedTokens = [];
const CAPTCHA_TTL = 120000;

const TRANSIT_SITE_KEY = "0x4AAAAAACghKkJHL1t7UkuZ";
const SITE_URL = "https://appointment.ivacbd.com";
let CapInfo = panelConfig.capInfo || { type: null, key: null };

// STARTUP: Load saved profiles
if (Array.isArray(panelConfig.profiles)) {
    panelConfig.profiles.forEach(p => {
        profileStates.set(p.id, createProfileState(p));
    });
}

let sendOtpWorkerCount = 0;
let verifyOtpWorkerCount = 0;
let reserveSlotWorkerCount = 0;
let payNowWorkerCount = 0;

let sendOtp403Count = 0;
let lastSendOtp403Time = 0;
let verifyOtp403Count = 0;
let lastVerifyOtp403Time = 0;
let reserveSlot403Count = 0;
let lastReserveSlot403Time = 0;

let isOtpVerifyAggressive = false;
let isReserveStarted = false;
let isReserveOtpSend = false;
let globalOtpVerified = false;

let pollingOtp = false;
let lastGetOtp = [];

// Auth Store
let authStorage = {
    state: { 
        token: null, 
        userId: null, 
        expiresAt: 899,
        isAuthenticated: false,
        isVerified: false,
        requestId: null, 
        phone: null, 
        password: null,
        otpSentAt: null 
    },
    version: 0
};
const getAuthToken = () => authStorage.state.token;

async function startWorkerCapMonster(id, signal, pState = null) {
    const API = "https://api.capmonster.cloud";
    const log = (m, c) => {
        if (pState) {
            logProfile(pState, `[Captcha] ${m}`, c);
        } else {
            logSolver(`[W#${id}] ${m}`, c);
        }
    };

    let attempts = 0;
    while (!signal?.aborted && attempts < 3) {
        attempts++;
        try {
            log(`CapMonster Creating Task...`, "#3b82f6");
            const create = await gotScraping.post(`${API}/createTask`, {
                json: {
                    clientKey: CapInfo.key,
                    task: { type: "TurnstileTaskProxyless", websiteURL: SITE_URL, websiteKey: TRANSIT_SITE_KEY }
                },
                responseType: "json", signal
            });
            const { taskId, errorId, errorDescription } = create.body;
            if (errorId !== 0) throw new Error(errorDescription || "Create Task Failed");
            let pollCount = 0;
            const POLL_LIMIT = 30;
            while (!signal?.aborted) {
                pollCount++;
                if (pollCount > POLL_LIMIT) {
                    log(`Polling limit reached.`, "#f59e0b");
                    break;
                }
                await new Promise(r => setTimeout(r, 800));
                if (signal?.aborted) return null;
                const check = await gotScraping.post(`${API}/getTaskResult`, {
                    json: { clientKey: CapInfo.key, taskId },
                    responseType: "json", signal,
                    timeout: { request: 30000 }
                });
                const result = check.body;
                if (result.errorId && result.errorId !== 0) throw new Error(result.errorDescription || "Task failed");
                if (result.status === "ready" && result.solution?.token) {
                    log(`Solved Successfully!`, "#10b981");
                    return result.solution.token;
                }
                if (result.status === "failed") throw new Error("Task failed");
            }
        } catch (err) {
            if (err.name === "AbortError") return null;
            log(`Attempt ${attempts} Failed: ${err.message}`, "#f59e0b");
            await new Promise(r => setTimeout(r, 2000));
        }
    }
    return null;
}

async function startWorkerCapSolver(id, signal, pState = null) {
    const API = "https://api.capsolver.com";
    const log = (m, c) => {
        if (pState) {
            logProfile(pState, `[Captcha] ${m}`, c);
        } else {
            logSolver(`[W#${id}] ${m}`, c);
        }
    };

    let attempts = 0;
    while (!signal?.aborted && attempts < 3) {
        attempts++;
        try {
            log(`CapSolver Creating Task...`, "#3b82f6");
            const create = await gotScraping.post(`${API}/createTask`, {
                json: {
                    clientKey: CapInfo.key,
                    task: { type: "AntiTurnstileTaskProxyLess", websiteURL: SITE_URL, websiteKey: TRANSIT_SITE_KEY }
                },
                responseType: "json", signal
            });
            const createData = create.body;
            if (createData.errorId !== 0) throw new Error(createData.errorDescription || "Create Task Failed");
            const taskId = createData.taskId;
            let pollCount = 0;
            const POLL_LIMIT = 25; // Increased limit
            while (!signal?.aborted) {
                pollCount++;
                if (pollCount > POLL_LIMIT) {
                    logSolver(`[Worker #${id}] CapSolver Polling limit reached. Retrying task...`, "#f59e0b");
                    break; // retry inner loop
                }
                await new Promise(r => setTimeout(r, 800));
                if (signal?.aborted) return null;
                const check = await gotScraping.post(`${API}/getTaskResult`, {
                    json: { clientKey: CapInfo.key, taskId },
                    responseType: "json", signal,
                    timeout: { request: 30000 }
                });
                const result = check.body;
                if (result.errorId && result.errorId !== 0) throw new Error(result.errorDescription || "Task failed");
                if (result.status === "ready" && result.solution?.token) {
                    log(`Captcha Solved!`, "#10b981");
                    return result.solution.token;
                }
                if (result.status === "failed") throw new Error("Task failed");
            }
        } catch (err) {
            if (err.name === "AbortError") return null;
            log(`Attempt ${attempts} Failed: ${err.message}`, "#ef4444");
            await new Promise(r => setTimeout(r, 2000));
        }
    }
    return null;
}

async function queueToken(force = false) {
    if (!force && (preSolvedTokens.length + solversInProgress >= 1)) return false;
    io.emit("btn-reset", { id: "solver", text: "Solving API..." });
    const token = await __solveAggressive();
    if (token) {
        preSolvedTokens.push({ token, time: Date.now() });
        io.emit("btn-reset", { id: "solver", text: `🧩 Solver (${preSolvedTokens.length})` });
        return true;
    } else {
        io.emit("btn-reset", { id: "solver", text: preSolvedTokens.length > 0 ? `🧩 Solver (${preSolvedTokens.length})` : "🧩 Solver" });
    }
    return false;
}

async function solveAggressive(pState = null) {
    // 1. Check pool
    while (preSolvedTokens.length > 0) {
        const item = preSolvedTokens.shift();
        if (Date.now() - item.time <= 80000) {
            io.emit("btn-reset", { id: "solver", text: preSolvedTokens.length > 0 ? `🧩 Solver (${preSolvedTokens.length})` : "🧩 Solver" });
            if (pState) logProfile(pState, "Using pre-solved token from pool.", "#10b981");
            return { token: item.token, time: item.time };
        }
    }
    const t = await __solveAggressive(pState);
    if (t) return { token: t, time: Date.now() };
    return null;
}

async function __solveAggressive(pState = null) {
    if (!CapInfo?.type || !CapInfo?.key) {
        const err = "No Cap API keys set! Auto solve disabled.";
        logSolver(err, "#dc2626");
        if (pState) logProfile(pState, err, "#ef4444");
        return null;
    }
    
    solversInProgress++;
    const msg = "🧩 Requesting Captcha Solve...";
    if (pState) logProfile(pState, msg, "#3b82f6");
    else logSolver(msg, "#3b82f6");
    
    const taskName = "captchaSolver";
    const controller = TaskManager.start(taskName);
    const { signal } = controller;
    
    const safetyTimeout = setTimeout(() => {
        controller.abort();
    }, 90000);

    let workerPromises = [];
    if (CapInfo.type === "capsolver") {
        workerPromises.push(startWorkerCapSolver(1, signal, pState));
    } else {
        workerPromises.push(startWorkerCapMonster(1, signal, pState));
    }
    
    try {
        const token = await Promise.any(workerPromises.filter(p => p !== null));
        if (token && !signal.aborted) {
            return token;
        }
    } catch (e) {
        if (!signal.aborted) {
            logSolver(`⚠️ Captcha Solve Failed`, "#ef4444");
            if (pState) logProfile(pState, "Captcha Solve Failed", "#ef4444");
        }
    } finally {
        clearTimeout(safetyTimeout);
        controller.abort();
        solversInProgress--;
        TaskManager.removeController(taskName, controller);
    }
    return null;
}

// ==========================================
// PORTED FUNCTIONS
// ==========================================

async function getOtpOnce(pState) {
    if (!pState.mobile) return false;
    const taskName = `GetOtpOnce-${pState.id}`;
    const controller = TaskManager.start(taskName);
    try {
        const res = await gotScraping(`https://sms.mrshuvo.xyz/ivac/${pState.mobile}`, { signal: controller.signal, responseType: "json" });
        const data = res.body;
        const otp = data?.data?.otp;
        if (data?.success && otp && otp !== "Invalid" && otp.length === 6 && !pState.flags.lastGetOtp.includes(otp)) {
            pState.PRE_FETCHED_OTP = otp;
            pState.flags.lastGetOtp.push(otp);
            logProfile(pState, `OTP Found & Stored backend: ${otp}`, "#16a34a", data);
            TaskManager.removeController(taskName, controller);
            return otp;
        }
        TaskManager.removeController(taskName, controller);
        return false;
    } catch (err) {
        TaskManager.removeController(taskName, controller);
        if (err.name === "AbortError") return false;
        logProfile(pState, "Failed to fetch OTP from SMS API", "#ef4444");
        return false;
    }
}

async function pollOtpLoop(pState, retrySettings, isManual = false) {
    retrySettings = retrySettings || {}; if (Object.keys(GLOBAL_RETRY_SETTINGS).length) Object.assign(retrySettings, GLOBAL_RETRY_SETTINGS);
    const taskName = `GetOtp-${pState.id}`;
    const maxTries = 20;

    if (pState.flags.pollingOtp) {
        if (isManual) {
            pState.flags.pollingOtp = false;
            TaskManager.stopTask(taskName);
            logProfile(pState, "Stopped searching OTP", "#64748b");
        }
        return;
    }

    pState.flags.pollingOtp = true;
    logProfile(pState, "Searching OTP...", "#3b82f6");

    let attempts = 0;

    const tryFetch = async () => {
        if (!pState.flags.pollingOtp) return;
        attempts++;
        if (attempts > maxTries) {
            pState.flags.pollingOtp = false;
            logProfile(pState, `OTP not found after ${maxTries} attempts`, "#ef4444");
            return;
        }

        const foundOtp = await getOtpOnce(pState);
        if (foundOtp) {
            pState.flags.pollingOtp = false;
            if (pState.flags.isReserveOtpSend) {
                pState.PRE_FETCHED_OTP = foundOtp;
                logProfile(pState, `Reserve OTP Found: ${foundOtp}`, "#10b981");
            } else if (retrySettings?.enabled) {
                const otpToUse = pState.PRE_FETCHED_OTP || foundOtp;
                pState.PRE_FETCHED_OTP = null;
                logProfile(pState, `OTP Found: ${otpToUse}. Verifying...`, "#b057ff", { foundOtp: otpToUse });
                verifyOtpAggressive(pState, otpToUse, retrySettings);
            } else {
                pState.PRE_FETCHED_OTP = foundOtp;
            }
            return;
        }

        if (pState.flags.pollingOtp && attempts < maxTries) {
            TaskManager.setTimeout(taskName, tryFetch, 1000);
        } else {
            pState.flags.pollingOtp = false;
            logProfile(pState, `OTP not found after ${maxTries} attempts`, "#ef4444");
        }
    };
    tryFetch();
}

async function reserveOtp(pState, retrySettings, isPreWarmup = false) {
    retrySettings = retrySettings || {}; if (Object.keys(GLOBAL_RETRY_SETTINGS).length) Object.assign(retrySettings, GLOBAL_RETRY_SETTINGS);
    pState.flags.isReserveOtpSend = true; logProfile(pState, "Initiating Reserve OTP...", "#3b82f6");

    pState.workerCounts.sendOtp++;
    const workerId = pState.workerCounts.sendOtp;
    const taskName = `ReserveOtp-${pState.id}-${workerId}`;
    const controller = TaskManager.start(taskName);

    const trySend = async (workerId, oldTokenToUse = null, oldTokenTime = null) => {
        if (controller.signal.aborted) return;
        
        if (global403PauseUntil && Date.now() < global403PauseUntil) {
            return TaskManager.setTimeout(taskName, () => trySend(workerId, oldTokenToUse, oldTokenTime), global403PauseUntil - Date.now());
        }

        const wTag = `[W-${workerId}|${getNetworkTitle(workerId)}]`;
        try {
            let tokenToUse;
            let tokenTime;
            if (oldTokenToUse) {
                tokenToUse = oldTokenToUse;
                tokenTime = oldTokenTime;
            } else {
                const solveRes = await solveAggressive(pState);
                if (!solveRes) { logProfile(pState, "Captcha failed", "#ef4444"); return; }
                tokenToUse = solveRes.token;
                tokenTime = solveRes.time;
            }

            const payload = { email: pState.email, "otpChannel": "PHONE", captchaToken: tokenToUse };
            const reqStart = Date.now();
            const res = await getGotClient(`ReserveOTP-W${workerId}`, workerId).post(`${RootUrl}/iams/api/v1/forgot-password/sendOtp`, {
                json: payload, responseType: "json", signal: controller.signal,
                headers: { "accept": "application/json, text/plain, */*", "cache-control": "no-cache, no-store, must-revalidate" }
            });

            const data = res.body;
            const reqDuration = Date.now() - reqStart;

            if (res.statusCode === 200 && data?.successFlag) {
                TaskManager.stopTask(taskName);
                logProfile(pState, `ReserveOtp Send Success`, "#10b981", data);

                pState.workerCounts.sendOtp = 0;
                pState.authStorage.state.requestId = data.data?.requestId;
                pState.authStorage.state.otpSentAt = Date.now();
                pState.flags.isReserveOtpSend = isPreWarmup;
                
                TaskManager.setTimeout(`GetOtp-${pState.id}`, () => pollOtpLoop(pState, retrySettings), 1000);
                return;
            }

            if (res.statusCode !== 200) {
                if (!retrySettings?.enabled) {
                    TaskManager.removeController(taskName, controller);
                    logProfile(pState, `ReserveOtp Status [${res.statusCode}]`, "#ef4444", data);
                    return;
                }
                
                let waitMs = (retrySettings.seconds || 5) * 1000;
                if (res.statusCode === 403 || res.statusCode === 503) waitMs = 2500 + Math.floor(Math.random() * 501);
                else if (res.statusCode === 429) waitMs = 20000;
                else if ([500, 501, 502, 504].includes(res.statusCode)) waitMs = 1500 + Math.floor(Math.random() * 500);

                const isTokenFresh = (Date.now() - tokenTime) <= 40000;
                let canReuse = isTokenFresh && (res.statusCode === 403 || reqDuration < 3000);
                if (res.statusCode === 400) canReuse = false;
                const tokenForRetry = canReuse ? tokenToUse : null;
                const timeForRetry = tokenForRetry ? tokenTime : null;
                
                logProfile(pState, `ReserveOtp Retry [${res.statusCode}] in ${(waitMs/1000).toFixed(1)}s`, "#eab308", data);
                return TaskManager.setTimeout(taskName, () => trySend(workerId, tokenForRetry, timeForRetry), waitMs);
            }
        } catch (err) {
            if (err.name === "AbortError") return;
            const wait = 1000;
            const isTokenAlive = tokenToUse && tokenTime && (Date.now() - tokenTime) < CAPTCHA_TTL;
            const tokenForRetry = isTokenAlive ? tokenToUse : null;
            logProfile(pState, `ReserveOtp Net Error. Reusing Token: ${!!tokenForRetry}`, "#ef4444");
            return TaskManager.setTimeout(taskName, () => trySend(workerId, tokenForRetry, tokenTime), wait);
        }
    };
    trySend(workerId);
}


async function sendOtp(pState, retrySettings, oldOtpBoxValue = null, isManual = false, batchTokens = null) {
    retrySettings = retrySettings || {}; if (Object.keys(GLOBAL_RETRY_SETTINGS).length) Object.assign(retrySettings, GLOBAL_RETRY_SETTINGS);
    pState.steps.signin = 'active';
    const taskName = `SendOtp-${pState.id}`;
    logProfile(pState, "Initiating Send OTP...", "#3b82f6");

    let successTriggered = false;
    let activeCount = 0;
    let batchFailed = 0;
    let sendOtpBatchTokenMap = [];

    const trySend = async (id, delay = 0, oldTokenToUse = null, oldTokenTime = null) => {
        const controller = TaskManager.start(taskName);
        if (delay) await new Promise(r => TaskManager.setTimeout(taskName, r, delay));
        if (successTriggered || controller.signal.aborted) return;

        if (global403PauseUntil && Date.now() < global403PauseUntil) {
            return TaskManager.setTimeout(taskName, () => trySend(id, delay, oldTokenToUse, oldTokenTime), global403PauseUntil - Date.now());
        }

        const wTag = `[W-${id}|${getNetworkTitle(id)}]`;
        const onFail = (waitMs, reuseToken = null, reuseTokenTime = null) => {
            if (!retrySettings?.enabled) return;
            if ((retrySettings.logic === "batch" || retrySettings.logic === "single-batch") && activeCount > 1) {
                sendOtpBatchTokenMap.push({ token: reuseToken, time: reuseTokenTime });
                batchFailed++;
                if (batchFailed === activeCount && !successTriggered) {
                    batchFailed = 0;
                    const tokenSnapshot = [...sendOtpBatchTokenMap];
                    sendOtpBatchTokenMap = [];
                    logProfile(pState, `[${retrySettings.logic}] All ${activeCount} workers failed. Retrying...`, "#fbbf24");
                    TaskManager.setTimeout(taskName, () => sendOtp(pState, retrySettings, oldOtpBoxValue, false, tokenSnapshot), 1000);
                }
            } else {
                TaskManager.setTimeout(taskName, () => trySend(id, 0, reuseToken, reuseTokenTime), waitMs);
            }
        };

        try {
            let tokenToUse;
            let tokenTime;
            if (oldTokenToUse) {
                tokenToUse = oldTokenToUse;
                tokenTime = oldTokenTime;
            } else {
                const solveRes = await solveAggressive(pState);
                if (!solveRes) { logProfile(pState, "Captcha failed", "#ef4444"); return; }
                tokenToUse = solveRes.token;
                tokenTime = solveRes.time;
            }

            const payload = { captchaToken: tokenToUse, phone: pState.mobile, password: pState.password };
            const reqStart = Date.now();
            const response = await getGotClient(`SendOTP-W${id}`, id).post(`${RootUrl}/iams/api/v1/auth/signin`, {
                json: payload, responseType: "json", signal: controller.signal,
                headers: { "accept": "application/json, text/plain, */*", "cache-control": "no-cache, no-store, must-revalidate" }
            });

            const data = response.body;
            const reqDuration = Date.now() - reqStart;

            if (response.statusCode === 200 && data?.successFlag) {
                successTriggered = true;
                TaskManager.stopTask(taskName);
                pState.steps.signin = 'done';
                pState.steps.verify = 'active';
                logProfile(pState, `SendOTP successfully.Searching..`, "#10b981", data);

                pState.flags.isReserveStarted = false;
                pState.flags.isOtpVerifyAggressive = false;
                pState.flags.globalOtpVerified = false;

                pState.authStorage.state.token = data.data?.accessToken;
                pState.authStorage.state.userId = data.data?.userId;
                pState.authStorage.state.requestId = data.data?.requestId;
                pState.authStorage.state.otpSentAt = Date.now();
                
                const boxOtpValid = oldOtpBoxValue && oldOtpBoxValue !== "Invalid" && oldOtpBoxValue.length === 6;
                
                if (pState.PRE_FETCHED_OTP) {
                    const otpToUse = pState.PRE_FETCHED_OTP;
                    pState.PRE_FETCHED_OTP = null; 
                    verifyOtpAggressive(pState, otpToUse, retrySettings);
                } else if (boxOtpValid) {
                    verifyOtpAggressive(pState, oldOtpBoxValue, retrySettings);
                } else {
                    TaskManager.setTimeout(`GetOtp-${pState.id}`, () => pollOtpLoop(pState, retrySettings), 1000);
                }
                return;
            }

            if (response.statusCode !== 200) {
                if (response.statusCode === 429) {
                    const msg = data?.message || "";
                    let totalSec = 0;
                    const minMatch = msg.match(/(\d+)\s*min/i);
                    const secMatch = msg.match(/(\d+)\s*sec/i);
                    if (minMatch) totalSec += parseInt(minMatch[1]) * 60;
                    if (secMatch) totalSec += parseInt(secMatch[1]);

                    if (totalSec > 0) {
                        const waitMs = totalSec * 1000;
                        logProfile(pState, `OTP Limit Reached! Cooldown for ${totalSec}s.`, "#eab308", data);
                        TaskManager.stopTask(taskName);
                        pState.steps.signin = 'idle';
                        pState.otpWaitUntil = Date.now() + waitMs;
                        io.emit("profile-status", { profileId: pState.id, otpWaitUntil: pState.otpWaitUntil, msg: `OTP Limit Reached! Cooldown: ${totalSec}s`, type: 'error' });
                        
                        TaskManager.setTimeout(taskName, () => {
                            if (pState.otpWaitUntil) { // Proceed if not reset
                                pState.otpWaitUntil = null;
                                io.emit("profile-status", { profileId: pState.id, otpWaitUntil: null });
                                logProfile(pState, `Cooldown finished. Restarting Send OTP...`, "#3b82f6");
                                sendOtp(pState, retrySettings, oldOtpBoxValue, false, null);
                            }
                        }, waitMs + 1000); // 1 sec delay after countdown
                        return;
                    }

                    logProfile(pState, `OTP Limit Reached!`, "#ef4444", data);
                    TaskManager.stopTask(taskName);
                    pState.steps.signin = 'idle';
                    return;
                }

                if (response.statusCode === 401) {
                    logProfile(pState, "Session expired during Send OTP", "#ef4444", { clearOtp: true });
                    return;
                }

                let waitMs = (retrySettings.seconds || 5) * 1000;
                if (response.statusCode === 403 || response.statusCode === 503) waitMs = 2500 + Math.floor(Math.random() * 501);
                else if ([500, 501, 502, 504].includes(response.statusCode)) waitMs = 1500 + Math.floor(Math.random() * 500);

                const isTokenFresh = (Date.now() - tokenTime) <= 40000;
                let canReuse = isTokenFresh && (response.statusCode === 403 || reqDuration < 3000);
                if (response.statusCode === 400) canReuse = false;
                const tokenForRetry = canReuse ? tokenToUse : null;
                const timeForRetry = tokenForRetry ? tokenTime : null;
                
                logProfile(pState, `Send OTP Retry [${response.statusCode}] in ${(waitMs/1000).toFixed(1)}s`, "#eab308", data);
                return onFail(waitMs, tokenForRetry, tokenTime);
            }
        } catch (err) {
            if (err.name === "AbortError") return;
            const isTokenAlive = tokenToUse && tokenTime && (Date.now() - tokenTime) < CAPTCHA_TTL;
            const tokenForRetry = isTokenAlive ? tokenToUse : null;
            logProfile(pState, `Send OTP Net Error. Reusing Token: ${!!tokenForRetry}`, "#ef4444");
            return onFail(1000, tokenForRetry, tokenTime);
        }
    };

    const isRunning = TaskManager.tasks[taskName]?.controllers.size > 0;
    let numWorkers;
    if (isManual && isRunning) {
        numWorkers = 1;
    } else {
        numWorkers = parseInt(retrySettings?.mode, 10) || 1;
    }
    activeCount = numWorkers;

    const isSingleBatch = retrySettings?.logic === "single-batch";
    const hasReusable = batchTokens && batchTokens.some(t => t.token);

    if (isManual && isRunning) {
        trySend(pState.workerCounts.sendOtp + 1, 0);
    } else if (isSingleBatch && !hasReusable) {
        logProfile(pState, "[Single-Batch] Solving one captcha for all workers...", "#3b82f6");
        const solveRes = await solveAggressive(pState);
        if (!solveRes) { logProfile(pState, "Captcha solve failed for batch", "#ef4444"); return; }
        for (let i = 1; i <= numWorkers; i++) {
            const delay = (i === 1) ? 0 : (i - 1) * 150;
            trySend(i, delay, solveRes.token, solveRes.time);
        }
    } else {
        for (let i = 1; i <= numWorkers; i++) {
            const delay = (i === 1) ? 0 : (i - 1) * 150;
            const batchToken = batchTokens ? (batchTokens[i - 1]?.token || null) : null;
            const batchTokenTime = batchTokens ? (batchTokens[i - 1]?.time || null) : null;
            trySend(i, delay, batchToken, batchTokenTime);
        }
    }
}

async function verifyOtpAggressive(pState, otp, retrySettings, isAutoRetry = false, isManual = false) {
    retrySettings = retrySettings || {}; if (Object.keys(GLOBAL_RETRY_SETTINGS).length) Object.assign(retrySettings, GLOBAL_RETRY_SETTINGS);
    pState.steps.verify = 'active';
    const taskName = `VerifyOtp-${pState.id}`;
    const requestId = pState.authStorage.state.requestId;
    const accessToken = pState.authStorage.state.token;

    if (!otp || !requestId || !accessToken) {
        logProfile(pState, "Verify OTP Failed: Missing Credentials", "#ef4444");
        return;
    }

    logProfile(pState, `Verifying OTP: ${otp}...`, "#3b82f6");
    let successTriggered = false;

    const payload = { requestId, phone: pState.mobile, code: otp, otpChannel: "PHONE" };
    const headers = {
        "accept": "application/json, text/plain, */*",
        "cache-control": "no-cache, no-store, must-revalidate",
        "authorization": "Bearer " + accessToken
    };

    const handleSuccess = (msg, responseData = null) => {
        if (successTriggered) return;
        successTriggered = true;
        pState.workerCounts.verifyOtp = 0;
        pState.flags.globalOtpVerified = true;
        TaskManager.stopTask(taskName);
        pState.steps.verify = 'done';
        pState.steps.reserve = 'active';
        pState.verifiedAt = Date.now();
        logProfile(pState, `OTP Verified! Slot Reservation Active.`, "#16a34a", responseData);

        pState.authStorage.state.isAuthenticated = true;
        pState.authStorage.state.isVerified = true;
        pState.PRE_FETCHED_OTP = null;

        // Auto-Trigger Reservation if in window
        const bdNow = new Date(new Date().getTime() + 6 * 60 * 60 * 1000);
        const totalMins = bdNow.getUTCHours() * 60 + bdNow.getUTCMinutes();
        const isWithinWindow = totalMins >= (17 * 60) && totalMins <= (23 * 60);

        if (isWithinWindow) {
            if (!pState.flags.isReserveStarted && retrySettings?.enabled) {
                pState.flags.isReserveStarted = true;
                reserveSlotAggressive(pState, retrySettings);
            }
        } else {
            logProfile(pState, "Reserve Time (5:00 PM-11:00 PM)", "#ef4444");
        }
    };

    let activeCount = 0;
    let batchFailed = 0;

    const worker = async (id, delay = 0) => {
        const controller = TaskManager.start(taskName);
        if (delay) await new Promise(r => TaskManager.setTimeout(taskName, r, delay));
        if (successTriggered || controller.signal.aborted) return;

        if (global403PauseUntil && Date.now() < global403PauseUntil) {
            return TaskManager.setTimeout(taskName, () => worker(id, delay), global403PauseUntil - Date.now());
        }

        const wTag = `[W-${id}|${getNetworkTitle(id)}]`;
        const onFail = (waitMs) => {
            if (!retrySettings?.enabled) return;
            if ((retrySettings.logic === "batch" || retrySettings.logic === "single-batch") && activeCount > 1) {
                batchFailed++;
                if (batchFailed === activeCount && !successTriggered) {
                    batchFailed = 0;
                    logProfile(pState, `[${retrySettings.logic}] All workers failed. Retrying Verify...`, "#fbbf24");
                    TaskManager.setTimeout(taskName, () => verifyOtpAggressive(pState, otp, retrySettings, true), 1000);
                }
            } else {
                TaskManager.setTimeout(taskName, () => worker(id), waitMs);
            }
        };

        try {
            const res = await getGotClient(`VerifyOTP-W${id}`, id).post(`${RootUrl}/iams/api/v1/otp/verifySigninOtp`, {
                json: payload, headers, responseType: "json", signal: controller.signal
            });
            const data = res.body;

            if (res.statusCode === 200 && data?.successFlag && data?.data?.verified) {
                if (data?.data?.accessToken) pState.authStorage.state.token = data.data.accessToken;
                return handleSuccess(`OTP Verified Successfully!`, data);
            }

            if (res.statusCode === 200 && data?.successFlag && data?.data?.verified === false) {
                logProfile(pState, "OTP Not Valid!", "#ef4444", data);
                TaskManager.setTimeout(`GetOtp-${pState.id}`, () => pollOtpLoop(pState, retrySettings), 500);
                return;
            }

            if (res.statusCode === 404) return handleSuccess("OTP Already Verified!", data);

            if (res.statusCode !== 200) {
                if (res.statusCode === 401) {
                    logProfile(pState, "Session expired during Verify OTP", "#ef4444", { clearOtp: true });
                    return;
                }
                if (!retrySettings?.enabled) return;
                let waitMs = (retrySettings.seconds || 5) * 1000;
                if (res.statusCode === 403 || res.statusCode === 503) waitMs = 4500 + Math.floor(Math.random() * 501);
                else if (res.statusCode === 429) waitMs = 20000;
                
                logProfile(pState, `Verify Retry [${res.statusCode}] in ${(waitMs/1000).toFixed(1)}s`, "#eab308", data);
                onFail(waitMs);
            }
        } catch (e) {
            if (e.name === "AbortError") return;
            logProfile(pState, `Verify Net Error: ${e.message}`, "#ef4444");
            onFail(1000);
        }
    };

    const isRunning = TaskManager.tasks[taskName]?.controllers.size > 0;
    const numModeWorkers = parseInt(retrySettings?.mode, 10) || 1;
    if (isManual && isRunning) {
        activeCount = 1;
        pState.workerCounts.verifyOtp++;
        worker(pState.workerCounts.verifyOtp, 0);
    } else {
        activeCount = numModeWorkers;
        const isBatch = retrySettings?.logic === "batch" || retrySettings?.logic === "single-batch";
        for (let i = 1; i <= numModeWorkers; i++) {
            let delay = (i === 1) ? 0 : (i - 1) * (isBatch ? 150 : 500);
            worker(i, delay);
        }
    }
}

async function uploadFile(socket, data) {
    if (!authStorage.state.token) {
        socket.emit("upload-file-result", { success: false, message: "No auth token" });
        return;
    }
    
    try {
        const buffer = Buffer.from(data.base64, 'base64');
        const blob = new Blob([buffer], { type: 'application/pdf' });
        
        const form = new FormData();
        form.append("file", blob, data.name);
        form.append("isPrimary", data.isPrimary);

        const client = getGotClient("UploadFile", 1);
        
        const response = await client.post(`${SITE_URL}/iams/api/v1/file/upload-file`, {
            headers: {
                "Authorization": `Bearer ${authStorage.state.token}`
            },
            body: form,
            responseType: "json"
        });

        socket.emit("upload-file-result", { success: true, data: response.body });
    } catch (err) {
        const bodyStr = err.response?.body;
        let jsonData = null;
        try {
            if (typeof bodyStr === "string") jsonData = JSON.parse(bodyStr);
            else if (typeof bodyStr === "object") jsonData = bodyStr;
        } catch(e){}
        
        if (jsonData) {
            socket.emit("upload-file-result", { success: true, data: jsonData }); 
        } else {
            socket.emit("upload-file-result", { success: false, message: err.message });
        }
    }
}

async function checkFile(socket) {
    if (TaskManager.tasks["checkFile"]?.controllers.size) {
        TaskManager.stopTask("checkFile");
        socket.emit("check-file-response", { status: "aborted" });
        return;
    }
    
    if (!authStorage.state.token) {
        socket.emit("check-file-response", { status: "token-expired" });
        return;
    }

    const controller = TaskManager.start("checkFile");
    const client = getGotClient("CheckFile", 1);
    
    try {
        const response = await client.post(`${SITE_URL}/iams/api/v1/file/overview`, {
            headers: {
                "Authorization": `Bearer ${authStorage.state.token}`
            },
            responseType: "json"
        });
        
        TaskManager.stopTask("checkFile");
        
        const data = response.body;
        if (data?.successFlag && data?.data && typeof data.data === 'object' && Object.keys(data.data).length > 0) {
            let activeFiles = data.data; 
            if (!Array.isArray(activeFiles)) activeFiles = [activeFiles];
            socket.emit("check-file-response", { status: "success", data: activeFiles });
        } else {
            socket.emit("check-file-response", { status: "no-data" });
        }
    } catch (err) {
        TaskManager.stopTask("checkFile");
        const status = err.response?.statusCode;
        if (status === 401) {
            socket.emit("check-file-response", { status: "token-expired" });
        } else if (status === 500) {
            socket.emit("check-file-response", { status: "error", message: "No file uploaded" });
        } else {
            socket.emit("check-file-response", { status: "error", message: err.message });
        }
    }
}

async function checkSlot(pState, retrySettings) {
    retrySettings = retrySettings || {}; if (Object.keys(GLOBAL_RETRY_SETTINGS).length) Object.assign(retrySettings, GLOBAL_RETRY_SETTINGS);
    if (!pState) return;
    const taskName = `CheckSlot-${pState.id}`;
    
    if (TaskManager.tasks[taskName]?.controllers.size) {
        TaskManager.stopTask(taskName);
        logProfile(pState, "Check slot aborted", "#ef4444");
        return;
    }

    logProfile(pState, "Checking slot status...", "#3b82f6");

    const token = pState.authStorage.state.token;
    if (!token) {
        logProfile(pState, "Check Slot Failed: No auth token", "#ef4444");
        return;
    }

    const controller = TaskManager.start(taskName);

    const trySlot = async () => {
        if (controller.signal.aborted) return;
        try {
            const res = await getGotClient("CheckSlot", null).get(`${RootUrl}/iams/api/v1/file/file-confirmation-and-slot-status`, {
                headers: { "Authorization": "Bearer " + token }, responseType: "json", signal: controller.signal
            });
            const data = res.body;

            if (res.statusCode === 200) {
                if (data?.data?.slotOpen) {
                    TaskManager.stopTask(taskName);
                    logProfile(pState, "SLOT IS OPEN!", "#16a34a", data);
                    if (!pState.flags.isReserveStarted && retrySettings?.enabled) {
                        pState.flags.isReserveStarted = true;
                        reserveSlotAggressive(pState, retrySettings);
                    }
                    return;
                }
                if (retrySettings?.enabled) {
                    const waitSec = retrySettings.seconds || 10;
                    logProfile(pState, `Slot not open. Retrying in ${waitSec}s...`, "#fbbf24");
                    await new Promise(r => TaskManager.setTimeout(taskName, r, waitSec * 1000));
                    return trySlot();
                }
                return TaskManager.stopTask(taskName);
            }

            if (res.statusCode !== 200) {
                if (res.statusCode === 401) {
                    TaskManager.stopTask(taskName);
                    logProfile(pState, "Session expired during Check Slot. Restarting...", "#ef4444", data);
                    resetProfileState(pState);
                    sendOtp(pState, retrySettings, null, false);
                    return;
                }
                if (retrySettings?.enabled) {
                    const waitSec = retrySettings.seconds || 10;
                    logProfile(pState, `CheckSlot status [${res.statusCode}]. Retrying ${waitSec}s...`, "#fbbf24");
                    await new Promise(r => TaskManager.setTimeout(taskName, r, waitSec * 1000));
                    return trySlot();
                }
                logProfile(pState, `Check Slot Failed: ${res.statusCode}`, "#ef4444", data);
                return;
            }
        } catch (err) {
            if (err.name === "AbortError") return;
            if (retrySettings?.enabled) {
                logProfile(pState, `CheckSlot net error. Retrying 10s...`, "#ef4444");
                await new Promise(r => TaskManager.setTimeout(taskName, r, 10000));
                return trySlot();
            } else {
                TaskManager.stopTask(taskName);
                logProfile(pState, `CheckSlot net error: ${err.message}`, "#ef4444");
            }
        }
    };
    trySlot();
}

async function reserveSlotAggressive(pState, retrySettings, isAutoRetry = false, isManual = false, batchTokens = null) {
    retrySettings = retrySettings || {}; if (Object.keys(GLOBAL_RETRY_SETTINGS).length) Object.assign(retrySettings, GLOBAL_RETRY_SETTINGS);
    pState.steps.reserve = 'active';
    const taskName = `ReserveSlot-${pState.id}`;
    const accessToken = pState.authStorage.state.token;

    if (!accessToken) {
        logProfile(pState, "Reserve Slot Failed: No access token", "#ef4444");
        return;
    }

    logProfile(pState, "Reserving slot...", "#3b82f6");
    let successTriggered = false;
    let activeCount = 0;
    let batchFailed = 0;
    let batchTokenMap = [];

    const worker = async (id, delay = 0, reuseToken = null, reuseTokenTime = null) => {
        const controller = TaskManager.start(taskName);
        if (delay) await new Promise(r => TaskManager.setTimeout(taskName, r, delay));
        if (successTriggered || controller.signal.aborted) return;
        
        if (global403PauseUntil && Date.now() < global403PauseUntil) {
            return TaskManager.setTimeout(taskName, () => worker(id, delay, reuseToken, reuseTokenTime), global403PauseUntil - Date.now());
        }

        const wTag = `[W-${id}|${getNetworkTitle(id)}]`;
        const onFail = (waitMs, reuseToken = null, reuseTokenTime = null) => {
            if (!retrySettings?.enabled) return;
            if ((retrySettings.logic === "batch" || retrySettings.logic === "single-batch") && activeCount > 1) {
                batchTokenMap.push({ token: reuseToken, time: reuseTokenTime });
                batchFailed++;
                if (batchFailed === activeCount && !successTriggered) {
                    batchFailed = 0;
                    const tokenSnapshot = [...batchTokenMap];
                    batchTokenMap = [];
                    logProfile(pState, `[${retrySettings.logic}] All workers failed. Retrying Reserve Slot...`, "#fbbf24");
                    TaskManager.setTimeout(taskName, () => reserveSlotAggressive(pState, retrySettings, true, false, tokenSnapshot), 1000);
                }
            } else {
                TaskManager.setTimeout(taskName, () => worker(id, 0, reuseToken, reuseTokenTime), waitMs);
            }
        };

        let recapToken;
        let tokenTime;
        if (reuseToken) {
            recapToken = reuseToken;
            tokenTime = reuseTokenTime;
        } else {
            let solveRes = await solveAggressive(pState);
            if (solveRes) { 
                recapToken = encryptCaptchaToken(solveRes.token);
                tokenTime = solveRes.time;
            } else { logProfile(pState, "Captcha solve failed", "#ef4444"); return; }
        }

        try {
            const reqStart = Date.now();
            const res = await getGotClient(`ReserveSlot-W${id}`, id).post(`${RootUrl}/iams/api/v1/slots/reserveSlot`, {
                json: { captchaToken: recapToken ,appointmentDate : "2026-05-04" }, 
                headers: { "authorization": "Bearer " + accessToken },
                responseType: "json", signal: controller.signal
            });
            const data = res.body;
            const reqDuration = Date.now() - reqStart;

            if (res.statusCode === 200 && ["OK_NEW", "OK_EXISTING"].includes(data?.status) && data?.reservationId) {
                successTriggered = true;
                pState.workerCounts.reserveSlot = 0;
                TaskManager.stopTask(taskName);
                pState.steps.reserve = 'done';
                pState.steps.pay = 'active';
                pState.reservedAt = Date.now();
                logProfile(pState, `[ RESERVED SUCCESSFULLY ]`, "#16a34a", data);
                // Immediately transition to Payment
                payNow(pState, retrySettings);
                io.emit("show-reservation-success-popup", { profileId: pState.id, taskName: pState.taskName });
                return;
            }

            if (res.statusCode === 200 && ["FULL", "NOT_OPEN", "SLOT_NOT_PREPARED"].includes(data?.status)) {
                const wait = (retrySettings.seconds || 10) * 1000;
                logProfile(pState, `Slot Status [ ${data?.status} ]. Retrying in ${wait/1000}s`, "#b057ff");
                queueToken();
                return onFail(wait, null);
            }

            if (res.statusCode !== 200) {
                if (res.statusCode === 401) {
                    if (successTriggered) return;
                    successTriggered = true;
                    TaskManager.stopTask(taskName);
                    logProfile(pState, "Session expired. Restarting from Send OTP...", "#ef4444", { clearOtp: true });
                    resetProfileState(pState);
                    sendOtp(pState, retrySettings, null, false);
                    return;
                }
                
                let waitMs = (retrySettings.seconds || 5) * 1000;
                if (res.statusCode === 403 || res.statusCode === 503) waitMs = 4500 + Math.floor(Math.random() * 501);

                const isTokenFresh = (Date.now() - tokenTime) <= 40000;
                let canReuse = isTokenFresh && (res.statusCode === 403 || reqDuration < 3000);
                if (res.statusCode === 400) canReuse = false;
                const tokenForRetry = canReuse ? recapToken : null;
                
                logProfile(pState, `Reserve Retry [${res.statusCode}] in ${(waitMs/1000).toFixed(1)}s`, "#eab308", data);
                return onFail(waitMs, tokenForRetry, tokenTime);
            }
        } catch (e) {
            if (e.name === "AbortError") return;
            logProfile(pState, `Reserve Net Error: ${e.message}`, "#ef4444");
            onFail(1500);
        }
    };

    const isRunning = TaskManager.tasks[taskName]?.controllers.size > 0;
    let numWorkersToStart;
    if (isManual && isRunning) {
        numWorkersToStart = 1;
    } else {
        numWorkersToStart = parseInt(retrySettings?.mode, 10) || 1;
    }
    activeCount = numWorkersToStart;

    const isSingleBatch = retrySettings?.logic === "single-batch";
    const hasReusable = batchTokens && batchTokens.some(t => t.token);

    if (isSingleBatch && !hasReusable) {
        logProfile(pState, "[Single-Batch] Solving fresh captcha for batch...", "#3b82f6");
        let solveRes = await solveAggressive(pState);
        if (!solveRes) { 
            logProfile(pState, "Captcha solve failed for batch. Retrying in 2s...", "#ef4444");
            TaskManager.setTimeout(taskName, () => reserveSlotAggressive(pState, retrySettings, true), 2000);
            return;
        }
        
        const recapToken = encryptCaptchaToken(solveRes.token);
        const tokenTime = solveRes.time;
        logProfile(pState, `[Single-Batch] Firing mode-wise stack (${numWorkersToStart}X) with same token...`, "#10b981");
        
        for (let i = 0; i < numWorkersToStart; i++) {
            const delay = i * 100; // Tighter delay for "stacking" effect
            worker(i + 1, delay, recapToken, tokenTime);
        }
    } else {
        // Mode-wise fire (Standard Batch or Manual)
        for (let i = 0; i < numWorkersToStart; i++) {
            const batchToken = batchTokens ? (batchTokens[i]?.token || null) : null;
            const batchTokenTime = batchTokens ? (batchTokens[i]?.time || null) : null;
            const delay = i * 250;
            worker(i + 1, delay, batchToken, batchTokenTime);
        }
    }
}

async function payNow(pState, retrySettings, isAutoRetry = false, isManual = false) {
    retrySettings = retrySettings || {}; if (Object.keys(GLOBAL_RETRY_SETTINGS).length) Object.assign(retrySettings, GLOBAL_RETRY_SETTINGS);
    pState.steps.pay = 'active';
    const taskName = `PayNow-${pState.id}`;
    const accessToken = pState.authStorage.state.token;

    if (!accessToken) { logProfile(pState, "Pay Now Failed: No access token", "#ef4444"); return; }
    
    logProfile(pState, "Initiating payment...", "#3b82f6");
    let successTriggered = false;

    const worker = async (id, delay = 0) => {
        const controller = TaskManager.start(taskName);
        if (delay) await new Promise(r => TaskManager.setTimeout(taskName, r, delay));
        if (successTriggered || controller.signal.aborted) return;

        try {
            const res = await getGotClient(`PayNow-W${id}`, id).post(`${RootUrl}/iams/api/v1/payment/ssl/initiate`, {
                headers: { "accept": "application/json, */*", "authorization": "Bearer " + accessToken },
                responseType: "json", signal: controller.signal, timeout: { request: 180000 }
            });
            const body = res.body;

            if (res.statusCode >= 200 && res.statusCode < 300 && body?.success && body?.data?.paymentUrl) {
                successTriggered = true;
                pState.steps.pay = 'done';
                pState.paymentUrl = body.data.paymentUrl;
                logProfile(pState, `PayNow success! Link generated.`, "#16a34a", body);
                TaskManager.stopTask(taskName);
                return;
            }

            if (res.statusCode === 401) {
                logProfile(pState, "Session expired. Restarting from first step...", "#ef4444", { clearOtp: true });
                return;
            }

            const wait = (retrySettings.seconds || 5) * 1000;
            logProfile(pState, `PayNow Retry [${res.statusCode}] in ${wait/1000}s`, "#eab308", body);
            TaskManager.setTimeout(taskName, () => worker(id), wait);

        } catch (err) {
            if (err.name === "AbortError") return;
            logProfile(pState, `PayNow Net Error: ${err.message}`, "#ef4444");
            TaskManager.setTimeout(taskName, () => worker(id), 2000);
        }
    };

    const isRunning = TaskManager.tasks[taskName]?.controllers.size > 0;
    let numWorkers;
    if (isManual && isRunning) {
        numWorkers = 1;
    } else {
        numWorkers = parseInt(retrySettings?.mode, 10) || 1;
    }

    for (let i = 1; i <= numWorkers; i++) {
        worker(i, (i - 1) * 200);
    }
}

// ==========================================
// SOCKET ROUTES
// ==========================================
io.on("connection", (socket) => {
    socket.authenticated = false;
    console.log("UI Connected:", socket.id);

    const secure = (handler) => (data, cb) => {
        if (!socket.authenticated) {
            socket.emit("status", { msg: "Unauthorized!", type: "error" });
            if (typeof cb === "function") cb(false);
            return;
        }
        return handler(data, cb);
    };

    socket.on("ping", () => socket.emit("pong"));

    // --- GLOBAL ACTIONS (PRIORITY) ---
    socket.on("all-profiles-start", secure((data) => {
        logSolver("📡 Received: GLOBAL START command", "#3b82f6");
        const count = profileStates.size;
        const retrySettings = data?.retrySettings || data || {}; 
        logSolver(`▶ GLOBAL START: Initiating ${count} profiles with Mode: ${retrySettings.mode || 'Default'}X`, "#10b981");
        
        profileStates.forEach(pState => {
            logProfile(pState, "Global start signal received.", "#3b82f6");
            sendOtp(pState, retrySettings, null, false);
        });
    }));

    socket.on("all-profiles-reserve-otp", secure((data) => {
        const retrySettings = data?.retrySettings || {};
        profileStates.forEach(pState => {
            logProfile(pState, "[Auto-Hit] Pre-warmup: Sending Reserve OTP...", "#3b82f6");
            reserveOtp(pState, retrySettings, true);
        });
    }));

    socket.on("bulk-solve-captcha", secure(async (data) => {
        const count = data?.count || 1;
        logSolver(`[Auto-Hit] Pre-solving ${count} captchas for queue...`, "#3b82f6");
        for (let i = 0; i < count; i++) {
            queueToken(true);
        }
    }));

    socket.on("all-profiles-stop", secure(() => {
        logSolver("📡 Received: GLOBAL STOP command", "#3b82f6");
        const count = profileStates.size;
        logSolver(`⏹ GLOBAL STOP: Halting all ${count} tasks...`, "#ef4444");
        profileStates.forEach(pState => {
            const profileId = pState.id;
            TaskManager.stopTask(`VerifyOtp-${profileId}`);
            TaskManager.stopTask(`SendOtp-${profileId}`);
            TaskManager.stopTask(`ReserveSlot-${profileId}`);
            TaskManager.stopTask(`PayNow-${profileId}`);
            TaskManager.stopTask(`GetOtp-${profileId}`);
            logProfile(pState, "Global Stop signal received.", "#64748b");
        });
    }));

    socket.on("all-profiles-reset", secure(() => {
        logSolver("📡 Received: GLOBAL RESET command", "#3b82f6");
        const count = profileStates.size;
        logSolver(`🔄 GLOBAL RESET: Wiping states/logs for all ${count} profiles...`, "#f59e0b");
        profileStates.forEach(pState => {
            const profileId = pState.id;
            TaskManager.stopTask(`VerifyOtp-${profileId}`);
            TaskManager.stopTask(`SendOtp-${profileId}`);
            TaskManager.stopTask(`ReserveSlot-${profileId}`);
            TaskManager.stopTask(`PayNow-${profileId}`);
            TaskManager.stopTask(`GetOtp-${profileId}`);
            
            resetProfileState(pState);
            
            try {
                const logFile = path.join(__dirname, "logs", `${profileId}.log`);
                if (fs.existsSync(logFile)) fs.truncateSync(logFile, 0);
            } catch (e) {}

            io.emit("profile-log-clear", profileId);
            logProfile(pState, "Profile global reset complete.", "#06b6d4");
        });
    }));

    socket.on("stop-all", secure(() => {
        TaskManager.stopAll();
        sendOtpWorkerCount = 0;
        verifyOtpWorkerCount = 0;
        reserveSlotWorkerCount = 0;
        payNowWorkerCount = 0;
        showStatus("Stopped All Backend Tasks", "error");
    }));

    socket.on("delete-all-profiles", secure(() => {
        logSolver("📡 Received: DELETE ALL PROFILES command", "#ef4444");
        const count = profileStates.size;
        TaskManager.stopAll();
        profileStates.clear();
        io.emit("all-profiles", []);
        logSolver(`🗑 DELETED ALL: Removed ${count} profiles from system.`, "#ef4444");
    }));
    
    socket.on("panel-login", (data, cb) => {
        if (data?.user === panelConfig.user && data?.pass === panelConfig.pass) {
            socket.authenticated = true;
            const token = generateSessionToken();
            if (typeof cb === "function") cb({ success: true, token });
            else socket.emit("login-success", { token });

            // Send all current profiles immediately
            socket.emit("all-profiles", Array.from(profileStates.values()));

            socket.emit("initial-config", {
                mobile: panelConfig.saved_mobile || "",
                email: panelConfig.saved_email || "",
                password: panelConfig.saved_password || "",
                capInfo: panelConfig.capInfo || { type: null, key: null },
                directApi: directApi,
                dnsIp: (dnsMap["api.ivacbd.com"] || [])[0] || null
            });
        } else {
            if (typeof cb === "function") cb({ success: false });
            else socket.emit("login-error", "Invalid Credentials");
        }
    });

    socket.on("panel-session-login", (data, cb) => {
        const isValid = data?.token 
            && data.token === panelConfig.sessionToken 
            && Date.now() < (panelConfig.sessionExpiry || 0);

        if (isValid) {
            socket.authenticated = true;
            if (typeof cb === "function") cb(true);

            // Send profiles and config for the resumed session
            socket.emit("all-profiles", Array.from(profileStates.values()));
            socket.emit("initial-config", {
                mobile: panelConfig.saved_mobile || "",
                email: panelConfig.saved_email || "",
                password: panelConfig.saved_password || "",
                capInfo: panelConfig.capInfo || { type: null, key: null },
                directApi: directApi,
                dnsIp: (dnsMap["api.ivacbd.com"] || [])[0] || null
            });
        } else {
            if (typeof cb === "function") cb(false);
        }
    });

    socket.on("save-file-info", secure((data) => {
        panelConfig.saved_mobile = data.mobile;
        panelConfig.saved_email = data.email;
        panelConfig.saved_password = data.password;
        fs.writeFileSync(path.join(__dirname, "config.json"), JSON.stringify(panelConfig, null, 2));
    }));
    

    // INITIAL BROADCAST (for already logged in clients)
    if (socket.authenticated) {
        socket.emit("all-profiles", Array.from(profileStates.values()));
    }

    socket.on("profile-check-slot", secure((data) => {
        const pState = profileStates.get(data.profileId);
        if (pState) checkSlot(pState, data.retrySettings);
    }));

    socket.on("cap-settings", secure((data) => { 
        panelConfig.capInfo = data;
        fs.writeFileSync(path.join(__dirname, "config.json"), JSON.stringify(panelConfig, null, 2));
        logSolver("Server received new Captcha Settings.", "#10b981"); 
    }));

    socket.on("update-direct-api", secure((payload) => {
        const isObject = typeof payload === 'object' && payload !== null;
        const newDirectApi = isObject ? payload.directApi : payload;
        const newDnsIp = isObject ? payload.dnsIp : null;
        
        setDirectApi(newDirectApi);

        if (newDnsIp) {
            dnsMap["api.ivacbd.com"] = [newDnsIp];
            panelConfig.saved_dns_ip = newDnsIp;
            fs.writeFileSync(path.join(__dirname, "config.json"), JSON.stringify(panelConfig, null, 2));
        } else {
            reloadDnsConfig();
        }
        workerNetworkClients.clear();
        const activeDns = directApi ? "Direct API Mode" : ((dnsMap["api.ivacbd.com"] || [])[0] || "Default");
        logSolver(`🌐 DNS Engine Updated → ${directApi ? "Direct" : "DNS Map"} | IP: ${activeDns}`, "#10b981");
    }));

    socket.on("global-settings-update", secure((settings) => {
        GLOBAL_RETRY_SETTINGS = settings;
    }));

    socket.on("proxy-state", secure((state) => { 
        currentProxyState = state; 
        workerNetworkClients.clear(); 
        logSolver(`✔ Proxy Engine mapped to: ${state.activeMode}`, "#3b82f6"); 
        reloadDnsConfig();
    }));

    socket.on("test-proxy", secure(async (data) => {
        const { index, proxy } = data;
        const startTime = performance.now();
        const credentials = (proxy.user && proxy.pass) ? `${proxy.user}:${proxy.pass}@` : "";
        const proxyUrl = `http://${credentials}${proxy.host}:${proxy.port}`;
        try {
            const res = await gotScraping.get(`${RootUrl}/iams/api/v1/slots/getVisaCenter`, {
                proxyUrl: proxyUrl, timeout: { request: 10000 }, throwHttpErrors: false, retry: { limit: 0 }
            });
            const ms = Math.floor(performance.now() - startTime);
            socket.emit("test-proxy-result", { index, success: true, status: res.statusCode, ms });
        } catch (e) {
            socket.emit("test-proxy-result", { index, success: false, status: e.code || e.message || "Error" });
        }
    }));

    socket.on("hard-reset", secure((data) => {
        TaskManager.stopAll();
        workerNetworkClients.clear();
        preSolvedTokens = [];
        solversInProgress = 0;
        io.emit("solver-clear");
        
        logSolver("------- [ RESTARTING ENGINE ] -------", "#3b82f6");
        logSolver("🚀 Server Restarting via PM2...", "#10b981");

        try {
            setTimeout(() => {
                try {
                    execSync("pm2 restart all", { stdio: "ignore" });
                } catch (err) {
                    console.error("PM2 Restart failed:", err.message);
                }
            }, 1000);
        } catch (error) {
            logSolver("❌ PM2 Restart failed. Check your process manager.", "#ef4444");
        }
    }));

    socket.on("git-update", secure((data) => {
        const msg = "🚀 Initiating System Update (git pull)...";
        logSolver(msg, "#3b82f6");
        
        const scriptPath = path.join(__dirname, "update.js");
        if (!fs.existsSync(scriptPath)) {
            logSolver("❌ update.js not found in root!", "#ef4444");
            return;
        }

        try {
            const updateProcess = spawn("node", [scriptPath], { 
                cwd: __dirname,
                env: { ...process.env, FORCE_COLOR: "1" },
                shell: true 
            });

            updateProcess.stdout.on("data", (data) => {
                const lines = data.toString().split("\n");
                lines.forEach(line => {
                    if (line.trim()) logSolver(line.trim(), "#10b981");
                });
            });

            updateProcess.stderr.on("data", (data) => {
                const lines = data.toString().split("\n");
                lines.forEach(line => {
                    if (line.trim()) logSolver(`[ERR] ${line.trim()}`, "#ef4444");
                });
            });

            updateProcess.on("error", (err) => {
                logSolver(`❌ Spawn Error: ${err.message}`, "#ef4444");
            });

            updateProcess.on("close", (code) => {
                if (code === 0) {
                    logSolver("✅ System Update Cycle Finished Successfully.", "#10b981");
                } else {
                    logSolver(`⚠️ Update Process exited with code ${code}`, "#f59e0b");
                }
            });
        } catch (e) {
            logSolver(`❌ Update execution failed: ${e.message}`, "#ef4444");
        }
    }));

    socket.on("profile-add", secure((pData) => {
        const pState = createProfileState(pData);
        profileStates.set(pState.id, pState);
        
        panelConfig.profiles = Array.from(profileStates.values()).map(s => ({
            id: s.id, taskName: s.taskName, email: s.email, mobile: s.mobile, password: s.password
        }));
        fs.writeFileSync(path.join(__dirname, "config.json"), JSON.stringify(panelConfig, null, 2));
        
        socket.emit("profile-added", pState);
        logProfile(pState, "Profile initialized and ready.", "#10b981");
    }));

    socket.on("profile-remove", (profileId) => {
        if (!socket.authenticated) {
            logSolver("❌ Unauthorized: Login required to delete profiles.", "#ef4444");
            return;
        }
        if (profileStates.has(profileId)) {
            const pState = profileStates.get(profileId);
            logSolver(`🗑️ Deleting Profile: ${pState.taskName} (${profileId})`, "#ef4444");
            
            TaskManager.stopTask(`VerifyOtp-${profileId}`);
            TaskManager.stopTask(`SendOtp-${profileId}`);
            TaskManager.stopTask(`ReserveSlot-${profileId}`);
            TaskManager.stopTask(`PayNow-${profileId}`);
            TaskManager.stopTask(`GetOtp-${profileId}`);
            
            profileStates.delete(profileId);
            panelConfig.profiles = Array.from(profileStates.values()).map(s => ({
                id: s.id, taskName: s.taskName, email: s.email, mobile: s.mobile, password: s.password
            }));
            fs.writeFileSync(path.join(__dirname, "config.json"), JSON.stringify(panelConfig, null, 2));
            io.emit("profile-removed", profileId);
        }
    });

    socket.on("profile-start", secure((data) => {
        const pState = profileStates.get(data.profileId);
        if (pState) {
            sendOtp(pState, data.retrySettings, null, true);
        }
    }));

    socket.on("profile-reserve", secure((data) => {
        const pState = profileStates.get(data.profileId);
        if (pState) reserveSlotAggressive(pState, data.retrySettings, false, true);
    }));

    socket.on("profile-paynow", secure((data) => {
        const pState = profileStates.get(data.profileId);
        if (pState) payNow(pState, data.retrySettings, false, true);
    }));

    socket.on("profile-reset", secure((profileId) => {
        const pState = profileStates.get(profileId);
        if (pState) {
            // Stop everything first
            TaskManager.stopTask(`SendOtp-${profileId}`);
            TaskManager.stopTask(`VerifyOtp-${profileId}`);
            TaskManager.stopTask(`ReserveSlot-${profileId}`);
            TaskManager.stopTask(`PayNow-${profileId}`);
            TaskManager.stopTask(`GetOtp-${profileId}`);
            
            resetProfileState(pState);
            
            // Clear log file
            try {
                const logFile = path.join(__dirname, "logs", `${profileId}.log`);
                if (fs.existsSync(logFile)) fs.truncateSync(logFile, 0);
            } catch (e) {}

            io.emit("profile-log-clear", profileId);
            logProfile(pState, "Profile state and logs have been reset.", "#06b6d4");
        }
    }));

    socket.on("profile-stop", secure((profileId) => {
        const pState = profileStates.get(profileId);
        if (pState) {
            TaskManager.stopTask(`VerifyOtp-${profileId}`);
            TaskManager.stopTask(`SendOtp-${profileId}`);
            TaskManager.stopTask(`ReserveSlot-${profileId}`);
            TaskManager.stopTask(`PayNow-${profileId}`);
            TaskManager.stopTask(`GetOtp-${profileId}`);
            logProfile(pState, "Task stopped manually.", "#64748b");
        }
    }));

    socket.on("profile-get-otp", secure((data) => {
        const pState = profileStates.get(data.profileId);
        if (pState) {
            pollOtpLoop(pState, data.retrySettings, true);
        }
    }));

    socket.on("profile-verify-otp", secure((data) => {
        const pState = profileStates.get(data.profileId);
        if (pState && data.otp) {
            verifyOtpAggressive(pState, data.otp, data.retrySettings, false, true);
        }
    }));

    socket.on("get-profile-log", secure((profileId) => {
        try {
            const logFile = path.join(__dirname, "logs", `${profileId}.log`);
            if (fs.existsSync(logFile)) {
                const content = fs.readFileSync(logFile, "utf8");
                socket.emit("profile-log-data", { profileId, content });
            } else {
                socket.emit("profile-log-data", { profileId, content: "Log file not found." });
            }
        } catch (e) {
            socket.emit("profile-log-data", { profileId, content: "Error reading log: " + e.message });
        }
    }));

    socket.on("clear-profile-log", secure((profileId) => {
        try {
            const logFile = path.join(__dirname, "logs", `${profileId}.log`);
            fs.writeFileSync(logFile, "");
            socket.emit("profile-log-cleared", profileId);
        } catch (e) {}
    }));

    // INITIAL LOAD
    socket.emit("all-profiles", Array.from(profileStates.values()));
});

const PORT = panelConfig.port || 5000;
const IP = panelConfig.ip || '0.0.0.0';
server.listen(PORT, IP, () => {
    console.log(`🎯 IVAC High-Speed Engine running perfectly on http://${IP}:${PORT}`);
});
