import { spawn } from "child_process";
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

let panelConfig = { user: "admin", pass: "admin123", ip: "0.0.0.0", port: 5000, main_ip: "", additional_ips: [], saved_mobile: "", saved_email: "", saved_password: "", capInfo: { type: null, key: null } };
try {
    const cf = fs.readFileSync(path.join(__dirname, "config.json"), "utf8");
    panelConfig = { ...panelConfig, ...JSON.parse(cf) };
} catch (e) {
    fs.writeFileSync(path.join(__dirname, "config.json"), JSON.stringify(panelConfig, null, 2));
}

// SECURE SESSION CONFIG
const SESSION_SECRET = "30c4e9e9e8104bfe1458348b69037995d8ed7d1fc407bfaab359dd59b6838862";
let currentSessionToken = null;
let sessionExpiry = 0;

function generateSessionToken() {
    currentSessionToken = Math.random().toString(36).substring(2) + Date.now().toString(36);
    sessionExpiry = Date.now() + (5 * 60 * 60 * 1000); // 5 Hours exactly as requested
    return currentSessionToken;
}

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
    const isReservation = taskName && taskName.startsWith("ReserveSlot");
    
    let key;
    let effectiveWorkerId = workerId;

    if (directApi) {
        // Mode A: Direct API - Unified Global Connection
        key = `direct-${activeMode}`;
        effectiveWorkerId = 1;
    } else if (isReservation) {
        // Mode B: DNS Mode - Worker-Locked IP
        key = `res-${activeMode}-${workerId}`;
    } else {
        // Standard flow
        key = `std-${activeMode}`;
        effectiveWorkerId = 1;
    }

    const proxyUrl = getProxyUrl(taskName, effectiveWorkerId, true);
    const netOpts = getNetworkOpts(effectiveWorkerId);
    
    if (!workerNetworkClients.has(key)) {
        const agentOpts = {
            keepAlive: true,
            maxSockets: 25,
            timeout: 60000,
            rejectUnauthorized: false
        };

        const client = gotScraping.extend({
            http2: true,
            throwHttpErrors: false,
            retry: { limit: 0 },
            timeout: { request: 120000 },
            proxyUrl: proxyUrl,
            agent: {
                http: new HttpAgent(agentOpts),
                https: new HttpsAgent(agentOpts)
            },
            hooks: {
                beforeRequest: [
                    (options) => {
                        const host = options.url.host;
                        
                        if (!directApi && isReservation && dnsMap[host]) {
                            const ips = dnsMap[host];
                            const ip = Array.isArray(ips) ? ips[(workerId - 1) % ips.length] : ips;
                            
                            options.url.hostname = ip;
                            options.headers.host = host;
                            if (!options.https) options.https = {};
                            options.https.servername = host; 
                            options.https.rejectUnauthorized = false;
                        }

                        if (tlsSessionCache.has(host)) {
                            if (!options.https) options.https = {};
                            options.https.tlsOptions = { ...options.https.tlsOptions, session: tlsSessionCache.get(host) };
                        }
                    }
                ],
                afterResponse: [
                    (response) => {
                        const host = response.request.options.url.host;
                        if (response.request.socket && response.request.socket.getSession) {
                            const session = response.request.socket.getSession();
                            if (session) tlsSessionCache.set(host, session);
                        }
                        return response;
                    }
                ],
                beforeError: [
                    (error) => {
                        const host = error.options?.url?.host;
                        if (host && (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT')) {
                            tlsSessionCache.delete(host);
                        }
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
    const isReservation = taskName && taskName.startsWith("ReserveSlot");
    let key;

    if (directApi) {
        key = `direct-${activeMode}`;
    } else if (isReservation) {
        key = `res-${activeMode}-${workerId}`;
    } else {
        key = `std-${activeMode}`;
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



// ==========================================
// STATE ENGINE
// ==========================================
const RootUrl = "https://api.ivacbd.com";

let UI_SOCKET = null;

const showStatus = (msg, type = "info") => UI_SOCKET?.emit("status", { msg, type });
const logSolver = (msg, color = "#fff", json = null) => {
    UI_SOCKET?.emit("solver-log", { msg, color, json });
};
const finishBtn = (id, text, stepStatus, activeStep) => UI_SOCKET?.emit("btn-reset", { id, text, stepStatus, activeStep: activeStep || id });

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
};

let sendOtpWorkerCount = 0;
let verifyOtpWorkerCount = 0;
let reserveSlotWorkerCount = 0;
let isOtpVerifyAggressive = false;
let isReserveStarted = false;
let isReserveOtpSend = false;
let globalOtpVerified = false;

let pollingOtp = false;
let lastGetOtp = [];

let solversInProgress = 0;
const CAPTCHA_TTL = 120000;

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

let CapInfo = panelConfig.capInfo || { type: null, key: null };
const TRANSIT_SITE_KEY = "0x4AAAAAACghKkJHL1t7UkuZ";
const SITE_URL = "https://appointment.ivacbd.com";

async function startWorkerCapMonoster(id, signal) {
    const API = "https://api.capmonster.cloud";
    let attempts = 0;
    while (!signal?.aborted && attempts < 3) {
        attempts++;
        try {
            if (signal?.aborted) return null;
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
            const POLL_LIMIT = 30; // Increased limit
            while (!signal?.aborted) {
                pollCount++;
                if (pollCount > POLL_LIMIT) {
                    logSolver(`[Worker #${id}] CapMonster Polling limit reached. Retrying task...`, "#f59e0b");
                    break; // break inner poll loop to recreate task
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
                if (result.status === "ready" && result.solution?.token) return result.solution.token;
                if (result.status === "failed") throw new Error("Task failed");
            }
        } catch (err) {
            if (err.name === "AbortError") return null;
            logSolver(`CapMonster Worker ${id} (Attempt ${attempts}) Failed: ${err.message}. Retrying...`, "#eab308");
            await new Promise(r => setTimeout(r, 2000));
        }
    }
    return null;
}

async function startWorkerCapSolver(id, signal) {
    const API = "https://api.capsolver.com";
    let attempts = 0;
    while (!signal?.aborted && attempts < 3) {
        attempts++;
        try {
            if (signal?.aborted) return null;
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
                if (result.status === "ready" && result.solution?.token) return result.solution.token;
                if (result.status === "failed") throw new Error("Task failed");
            }
        } catch (err) {
            if (err.name === "AbortError") return null;
            logSolver(`CapSolver Worker ${id} (Attempt ${attempts}) Failed: ${err.message}. Retrying...`, "#ef4444");
            await new Promise(r => setTimeout(r, 2000));
        }
    }
    return null;
}

let preSolvedTokens = [];
let PRE_FETCHED_OTP = null;

async function queueToken(force = false) {
    if (!force && (preSolvedTokens.length + solversInProgress >= 1)) return false;
    UI_SOCKET?.emit("btn-reset", { id: "solver", text: "Solving API..." });
    const token = await __solveAggressive();
    if (token) {
        preSolvedTokens.push({ token, time: Date.now() });
        UI_SOCKET?.emit("btn-reset", { id: "solver", text: `🧩 Solver (${preSolvedTokens.length})` });
        return true;
    } else {
        UI_SOCKET?.emit("btn-reset", { id: "solver", text: preSolvedTokens.length > 0 ? `🧩 Solver (${preSolvedTokens.length})` : "🧩 Solver" });
    }
    return false;
}

async function solveAggressive() {
    // 1. Check pool
    while (preSolvedTokens.length > 0) {
        const item = preSolvedTokens.shift();
        if (Date.now() - item.time <= 80000) {
            UI_SOCKET?.emit("btn-reset", { id: "solver", text: preSolvedTokens.length > 0 ? `🧩 Solver (${preSolvedTokens.length})` : "🧩 Solver" });
            return item.token;
        }
    }

    // 2. No more restriction - allow parallel solvers to start whenever pool is empty
    return await __solveAggressive();
}

async function __solveAggressive() {
    if (!CapInfo?.type || !CapInfo?.key) {
        logSolver("No Cap API keys set! Auto solve disabled.", "#dc2626");
        return null;
    }
    
    solversInProgress++;
    logSolver("🧩 API Captcha Solving...", "#3b82f6");
    
    const taskName = "captchaSolver";
    const controller = TaskManager.start(taskName);
    const { signal } = controller;
    
    // Safety timeout: Abort if not solved in 90s
    const safetyTimeout = setTimeout(() => {
        controller.abort();
        logSolver("⚠️ API Captcha Solver Timeout!", "#ef4444");
    }, 90000);

    let workerPromises = [];
    if (CapInfo.type === "capSolver") {
        workerPromises.push(startWorkerCapSolver(1, signal));
    } else {
        workerPromises.push(startWorkerCapMonoster(1, signal));
    }
    
    try {
        const token = await Promise.any(workerPromises.filter(p => p !== null));
        if (token && !signal.aborted) {
            logSolver(`🧩 API Token Solved.`, "#10b981");
            return token;
        }
    } catch (e) {
        if (!signal.aborted) logSolver(`⚠️ API Captcha Solve Failed`, "#ef4444");
    } finally {
        clearTimeout(safetyTimeout);
        controller.abort(); // Ensure everything is stopped
        solversInProgress--;
        TaskManager.removeController(taskName, controller);
    }
    return null;
}

// ==========================================
// PORTED FUNCTIONS
// ==========================================

async function getOtpOnce(taskName, mobile) {
    if (!mobile) { showStatus("Enter Mobile Number", "error"); return false; }
    const controller = TaskManager.start(taskName);
    try {
        const res = await gotScraping(`https://sms.mrshuvo.xyz/ivac/${mobile}`, { signal: controller.signal, responseType: "json" });
        const data = res.body;
        const otp = data?.data?.otp;
        if (data?.success && otp && otp !== "Invalid" && otp.length === 6 && !lastGetOtp.includes(otp)) {
            PRE_FETCHED_OTP = otp;
            UI_SOCKET?.emit("set-otp-value", otp);
            lastGetOtp.push(otp);
            showStatus("OTP Found & Stored backend", "success");
            logSolver(`Reserveotp OTP stored: ${otp}`, "#16a34a", data);
            TaskManager.removeController(taskName, controller);
            return otp;
        }
        TaskManager.removeController(taskName, controller);
        return false;
    } catch (err) {
        TaskManager.removeController(taskName, controller);
        if (err.name === "AbortError") return false;
        showStatus("Failed to get OTP", "error");
        return false;
    }
}

async function pollOtpLoop(mobile, __IVAC_RETRY__, isManual = false) {
    const taskName = "GetOtp";
    const maxTries = 20;

    if (pollingOtp) {
        if (isManual) {
            pollingOtp = false;
            TaskManager.stopTask(taskName);
            finishBtn("getOtp", "Get OTP", "none");
            showStatus("Stopped searching OTP", "info");
        }
        return;
    }

    pollingOtp = true;
    finishBtn("getOtp", "Searching...");
    showStatus("Searching OTP...", "info");
    if (isManual) logSolver("Searcing Reserveotp...");
    else logSolver("Auto Searching OTP...");

    let attempts = 0;

    const tryFetch = async () => {
        if (!pollingOtp) return;
        attempts++;
        if (attempts > maxTries) {
            pollingOtp = false;
            finishBtn("getOtp", "GET OTP", "none");
            showStatus(`OTP not found after ${maxTries} attempts`, "error");
            logSolver(`App OTP Not Found 20/20`, '#a85ee9');
            return;
        }

        const foundOtp = await getOtpOnce(taskName, mobile);
        if (foundOtp) {
            pollingOtp = false;
            finishBtn("getOtp", "GET OTP", "none");
            
            if (isReserveOtpSend) {
                // Scenario A: Pre-warmup (Auto Hit) -> Find and STOP
                PRE_FETCHED_OTP = foundOtp;
                logSolver(`${isManual ? "[Manual]" : "[Auto]"} Reserve OTP Found: ${foundOtp}`, "#10b981");
            } else if (__IVAC_RETRY__?.enabled) {
                // Scenario B: Active verification (Manual or Fallback) -> VERIFY
                const otpToUse = PRE_FETCHED_OTP || foundOtp;
                PRE_FETCHED_OTP = null;
                logSolver(`OTP Found: ${otpToUse}.try to verify`, "#b057ff");
                verifyOtpAggressive(mobile, otpToUse, __IVAC_RETRY__);
            } else {
                PRE_FETCHED_OTP = foundOtp;
            }
            return;
        }

        if (pollingOtp && attempts < maxTries) {
            showStatus(`Searching OTP. Attempt ${attempts}...`, "info");
            TaskManager.setTimeout(taskName, tryFetch, 800);
        } else {
            pollingOtp = false;
            finishBtn("getOtp", "GET OTP", "none");
            showStatus(`OTP not found after ${maxTries} attempts`, "error");
            logSolver(`App OTP Not Found 20/20`, '#a85ee9');
        }
    };
    tryFetch();
}

async function reserveOtp(email,mobile, __IVAC_RETRY__, isPreWarmup = false) {
    finishBtn("reserveOtp", "Sending...");
    showStatus("Sending OTP...", "info");

    sendOtpWorkerCount++;
    const workerId = sendOtpWorkerCount;
    const taskName = `ReserveOtp-${workerId}`;
    const controller = TaskManager.start(taskName);

    if (!email) {
        TaskManager.stopTask(taskName);
        return showStatus("Email required", "error");
    }

    const trySend = async (workerId, oldTokenToUse = null) => {
        if (controller.signal.aborted) return;
        
        const wTag = `[W-${workerId}|${getNetworkTitle(workerId)}]`;
        logSolver(`${wTag} ReserveOTP Started`, "#3b82f6");
        try {
            let tokenToUse;
            if (oldTokenToUse) {
                tokenToUse = oldTokenToUse;
            } else {
                tokenToUse = await solveAggressive();
            }
            if (!tokenToUse) { finishBtn("reserveOtp", "Reserve OTP"); return showStatus("Captcha failed", "error"); }

            const payload = { email, "otpChannel": "PHONE", captchaToken: tokenToUse };
            const res = await getGotClient(`ReserveOTP-W${workerId}`, workerId).post(`${RootUrl}/iams/api/v1/forgot-password/sendOtp`, {
                json: payload, responseType: "json", signal: controller.signal,
                headers: { "accept": "application/json, text/plain, */*", "cache-control": "no-cache, no-store, must-revalidate" }
            });

            const data = res.body;

            if (res.statusCode === 200 && data?.successFlag) {
                TaskManager.stopTask(taskName);
                finishBtn("reserveOtp", "Reserve OTP", "done");
                showStatus(`ReserveOtp Send Successfully`, "success");
                logSolver(`${wTag} ReserveOtp Send Success`, '#16a34a', data);

                sendOtpWorkerCount = 0;
                authStorage.state.requestId = data.data?.requestId;
                authStorage.state.phone = mobile;
                authStorage.state.email = email;
                authStorage.state.otpSentAt = Date.now();
                isReserveOtpSend = isPreWarmup;
                TaskManager.setTimeout('GetOtp', () => pollOtpLoop(mobile, __IVAC_RETRY__), 1000);
                
                return;
            }

            if (res.statusCode !== 200) {
                
                if (!__IVAC_RETRY__?.enabled) {
                    TaskManager.removeController(taskName, controller);
                    finishBtn("reserveOtp", "Reserve OTP");
                    if (res.statusCode === 403 || res.statusCode === 502 || res.statusCode === 504) {
                        logSolver(`${wTag} Reserve OTP Status [${res.statusCode}]`, '#d55252');
                    } else {
                        logSolver(`${wTag} Reserve OTP Status [${res.statusCode}]`, '#d55252', data);
                    }
                    return showStatus(data?.message || data?.error || "Failed", "error");
                }
                let waitMs = (__IVAC_RETRY__.seconds || 5) * 1000;
                if (res.statusCode === 403) {
                    waitMs = 2500 + Math.floor(Math.random() * 501); 
                } else if (res.statusCode === 503) {
                    waitMs = 800;
                } else if (res.statusCode === 429) {
                    waitMs = 20000;
                }else if ([500, 501, 502, 504, 520].includes(res.statusCode)) {
                    waitMs = 500 + Math.floor(Math.random() * 1000); 
                }else if ([400, 401].includes(res.statusCode)) { waitMs = 1000; }
                
                if (res.statusCode === 403 || res.statusCode === 502 || res.statusCode === 504) {
                    logSolver(`${wTag} ReserveOTP Status [${res.statusCode}]`, '#d55252');
                } else {
                    logSolver(`${wTag} ReserveOTP Status [${res.statusCode}]`, '#d55252', data);
                }

                if ([403, 503].includes(res.statusCode)) {
                    return TaskManager.setTimeout(taskName, () => trySend(workerId, tokenToUse), waitMs);
                } else {
                    return TaskManager.setTimeout(taskName, () => trySend(workerId), waitMs);
                }
            }

            finishBtn("reserveOtp", "Reserve OTP");
            TaskManager.removeController(taskName, controller);
        } catch (err) {
            if (err.name !== "AbortError" && __IVAC_RETRY__?.enabled) {
                logSolver(`${wTag} Send OTP Cross Error: ${err.message}`, '#d55252');
                return TaskManager.setTimeout(taskName, () => trySend(workerId), 1000);
            }
            TaskManager.removeController(taskName, controller);
            finishBtn("reserveOtp", "Reserve OTP");
        }
    };
    
    const numWorkers = 1;
    for (let i = 1; i <= numWorkers; i++) {
        trySend(i);
    }
}


async function sendOtp(email, mobile, mbpassword, __IVAC_RETRY__, oldOtpBoxValue) {
    finishBtn("sendOtp", "Sending...");
    showStatus("Sending OTP...", "info");
    // logSolver(`Send OTP Setup Initialized...`, '#3b82f6');

    if (!isReserveOtpSend) {
        if (oldOtpBoxValue && oldOtpBoxValue !== "Invalid" && oldOtpBoxValue.length === 6 && !lastGetOtp.includes(oldOtpBoxValue)) {
            lastGetOtp.push(oldOtpBoxValue);
            logSolver(`[Setup] Ignored box OTP: ${oldOtpBoxValue}`, "#6b7280");
        }
        gotScraping(`https://sms.mrshuvo.xyz/ivac/${mobile}`, { responseType: "json" })
            .then(tempRes => {
                const apiOtp = tempRes.body?.data?.otp;
                if (apiOtp && apiOtp !== "Invalid" && apiOtp.length === 6 && !lastGetOtp.includes(apiOtp)) {
                    lastGetOtp.push(apiOtp);
                    logSolver(`[Setup] Ignored previous API OTP: ${apiOtp}`, "#6b7280");
                }
            }).catch(() => {});
    }

    sendOtpWorkerCount++;
    const taskName = `sendOtp`;
    
    if (!mobile || !mbpassword) {
        return showStatus("Phone & Password required", "error");
    }

    let successTriggered = false;
    let activeCount = 0;

    const trySend = async (id, delay = 0, oldTokenToUse = null) => {
        const controller = TaskManager.start(taskName);
        if (delay) await new Promise(r => TaskManager.setTimeout(taskName, r, delay));
        if (successTriggered || controller.signal.aborted) return;

        const wTag = `[W-${id}|${getNetworkTitle(id)}]`;
        logSolver(`${wTag} SendOTP Started`, "#3b82f6");
        try {
            let tokenToUse;
            if (oldTokenToUse) {
                tokenToUse = oldTokenToUse;
            } else {
                tokenToUse = await solveAggressive();
            }
            if (!tokenToUse) { finishBtn("sendOtp", "Send OTP"); return showStatus("Captcha failed", "error"); }

            const payload = { captchaToken: tokenToUse, phone: mobile, password: mbpassword };

            const response = await getGotClient(`SendOTP-W${id}`, id).post(`${RootUrl}/iams/api/v1/auth/signin`, {
                json: payload, responseType: "json", signal: controller.signal,
                headers: { "accept": "application/json, text/plain, */*", "cache-control": "no-cache, no-store, must-revalidate" }
            });

            const data = response.body;

            if (response.statusCode === 200 && data?.successFlag) {
                successTriggered = true;
                TaskManager.stopTask(taskName);
                finishBtn("sendOtp", "Send OTP", "done");
                showStatus(`OTP Send Successfully`, "success");
                logSolver(`${wTag} OTP Send Successfully`, '#16a34a', data);

                isReserveStarted = false;
                isOtpVerifyAggressive = false;
                globalOtpVerified = false;

                if (isReserveOtpSend && authStorage.state.requestId) {
                    authStorage.state.token = data.data?.accessToken;
                    authStorage.state.userId = data.data?.userId;
                    authStorage.state.phone = mobile;
                    authStorage.state.password = mbpassword;
                    authStorage.state.otpSentAt = Date.now();
                    
                    isReserveOtpSend = false;
                    const boxOtpValid = oldOtpBoxValue && oldOtpBoxValue !== "Invalid" && oldOtpBoxValue.length === 6;
                    
                    if (PRE_FETCHED_OTP) {
                        const otpToUse = PRE_FETCHED_OTP;
                        PRE_FETCHED_OTP = null; 
                        verifyOtpAggressive(mobile, otpToUse, __IVAC_RETRY__);
                    } else if (boxOtpValid) {
                        verifyOtpAggressive(mobile, oldOtpBoxValue, __IVAC_RETRY__);
                    } else {
                        TaskManager.setTimeout('GetOtp', () => pollOtpLoop(mobile, __IVAC_RETRY__), 1000);
                    }

                return;

                } else {
                    authStorage.state.token = data.data?.accessToken;
                    authStorage.state.userId = data.data?.userId;
                    authStorage.state.requestId = data.data?.requestId;
                    authStorage.state.phone = mobile;
                    authStorage.state.password = mbpassword;
                    authStorage.state.otpSentAt = Date.now();
                    
                    isReserveOtpSend = false;
                    
                    TaskManager.setTimeout('GetOtp', () => pollOtpLoop(mobile, __IVAC_RETRY__), 1000);

                    return;
                }
            }

            if (response.statusCode !== 200) {
                if (!__IVAC_RETRY__?.enabled) {
                    TaskManager.removeController(taskName, controller);
                    finishBtn("sendOtp", "Send OTP", "none");
                    if (response.statusCode === 403 || response.statusCode === 502 || response.statusCode === 504) {
                        logSolver(`Send OTP [W${id}] Status [${response.statusCode}]`, '#d55252');
                    } else {
                        logSolver(`Send OTP [W${id}] Status [${response.statusCode}]`, '#d55252', data);
                    }
                    return showStatus(data?.message || data?.error || "Invalid credentials", "error");
                }
                
                let waitMs = (__IVAC_RETRY__.seconds || 5) * 1000;
                if (response.statusCode === 403) {
                    waitMs = 2500 + Math.floor(Math.random() * 501);
                } else if (response.statusCode === 503) {
                    waitMs = 800;
                } else if (response.statusCode === 429) {
                    waitMs = 20000; // 20s
                } else if ([500, 501, 502, 504, 520].includes(response.statusCode)) {
                    waitMs = 800 + Math.floor(Math.random() * 401);
                } else if ([400, 401].includes(response.statusCode)) {
                    waitMs = 1000;
                }
                if (response.statusCode === 429) {
                    TaskManager.stopTask(taskName);
                    logSolver(`${wTag} Send OTP 429 Blocked: ${data?.message}`, '#fbbf24');
                    showStatus(data?.message || "Rate Limited! Searching OTP...", "error");
                    
                    if (email) {
                        if (PRE_FETCHED_OTP && __IVAC_RETRY__?.enabled) {
                            logSolver(`[429 Fallback] Using Pre-fetched OTP: ${PRE_FETCHED_OTP}`, '#10b981');
                            const otpToUse = PRE_FETCHED_OTP;
                            PRE_FETCHED_OTP = null;
                            verifyOtpAggressive(mobile, otpToUse, __IVAC_RETRY__);
                            return;
                        }

                        logSolver(`[429 Fallback] No pre-fetched OTP. Searching SMS API...`, '#3b82f6');
                        lastGetOtp = []; 
                        
                        getGotClient("CheckActiveSMS").get(`https://sms.mrshuvo.xyz/ivac/${mobile}`, { responseType: "json", timeout: { request: 5000 } })
                            .then(res => {
                                const otpData = res.body?.data?.otp;
                                if (otpData && otpData !== "Invalid" && otpData.length === 6) {
                                    logSolver(`[429 Fallback] Found OTP waiting: ${otpData}. Bypassing ReserveOTP!`, '#10b981');
                                    verifyOtpAggressive(mobile, otpData, __IVAC_RETRY__);
                                } else {
                                    logSolver(`[429 Fallback] No OTP found. Triggering ReserveOTP...`, '#f59e0b');
                                    reserveOtp(email, mobile, __IVAC_RETRY__, false); // false = not pre-warmup, verify immediately
                                }
                            }).catch(() => {
                                reserveOtp(email, mobile, __IVAC_RETRY__, false);
                            });
                    } else {
                        logSolver(`Cannot fallback to ReserveOTP, no email matched!`, '#dc2626');
                    }
                    return;
                }

                if (response.statusCode === 403 || response.statusCode === 502 || response.statusCode === 504) {
                    logSolver(`${wTag} Send OTP Status [${response.statusCode}]`, '#d55252');
                } else {
                    logSolver(`${wTag} Send OTP Status [${response.statusCode}]`, '#d55252', data);
                }

                if ([403, 503].includes(response.statusCode)) {
                    return TaskManager.setTimeout(taskName, () => trySend(id, 0, tokenToUse), waitMs);
                } else {
                    return TaskManager.setTimeout(taskName, () => trySend(id), waitMs);
                }
            }

            finishBtn("sendOtp", "Send OTP", "none");
            TaskManager.removeController(taskName, controller);
        } catch (err) {
            if (err.name !== "AbortError" && __IVAC_RETRY__?.enabled) {
                logSolver(`${wTag} Send OTP Cross Error: ${err.message}`, '#d55252');
                return TaskManager.setTimeout(taskName, () => trySend(id), 1000);
            }
            TaskManager.removeController(taskName, controller);
            finishBtn("sendOtp", "Send OTP", "none");
        }
    };

    let numWorkers = 1;
    // if (__IVAC_RETRY__?.mode > 1) {
    //     numWorkers = parseInt(__IVAC_RETRY__.mode, 10) || 3;
    // }
    activeCount = numWorkers;

    for (let i = 1; i <= numWorkers; i++) {
        //let delay = (i === 1) ? 100 : ((i - 1) * 600 + Math.floor(Math.random() * 151));
        trySend(i, 0);
    }
}

async function verifyOtpAggressive(mobile, otp, __IVAC_RETRY__, isBatch = false) {
    const requestId = authStorage?.state?.requestId;
    const accessToken = authStorage?.state?.token;

    if (!otp || !requestId) {
        TaskManager.stopTask("verifyOtp");
        finishBtn("verifyOtp", "Verify OTP", "none");
        logSolver(`[Verify] Failed! Request ID not found.`, "#ef4444");
        return showStatus("OTP or requestId missing", "error");
    }
    if (!accessToken) {
        TaskManager.stopTask("verifyOtp");
        finishBtn("verifyOtp", "Verify OTP", "none");
        logSolver(`[Verify] Failed! access token not found.`, "#ef4444");
        return showStatus("Missing access token", "error");
    }

    finishBtn("verifyOtp", "Verifying...");
    showStatus("OTP verifying...", "info");
    let successTriggered = false;

    const payload = { requestId, phone: mobile, code: otp, otpChannel: "PHONE" };
    const headers = {
        "accept": "application/json, text/plain, */*",
        "cache-control": "no-cache, no-store, must-revalidate",
        "authorization": "Bearer " + accessToken
    };

    const handleSuccess = (msg, responseData = null) => {
        if (successTriggered) return;
        successTriggered = true;
        verifyOtpWorkerCount = 0;
        globalOtpVerified = true;
        TaskManager.stopTask("verifyOtp");
        finishBtn("verifyOtp", "Verify OTP", "done");
        showStatus(`${msg} ✓`, "success");
        logSolver(msg, '#16a34a', responseData);

        authStorage.state.isAuthenticated = true;
        authStorage.state.isVerified = true;
        
        PRE_FETCHED_OTP = null;
        UI_SOCKET?.emit("set-otp-value", "");
        UI_SOCKET?.emit("start-login-countdown", 15 * 60);

        if (!isReserveStarted && __IVAC_RETRY__?.enabled) {
            isReserveStarted = true;
            reserveSlotAggressive(__IVAC_RETRY__);
        }
    };

    let activeCount = 0;
    let batchFailed = 0;

    const worker = async (id, delay = 0) => {
        const controller = TaskManager.start("verifyOtp");
        if (delay) await new Promise(r => TaskManager.setTimeout("verifyOtp", r, delay));
        if (successTriggered || controller.signal.aborted) return;

        const wTag = `[W-${id}|${getNetworkTitle(id)}]`;
        logSolver(`${wTag} VerifyOTP Started`, "#3b82f6");
        
        const onFail = (waitMs) => {
            if (__IVAC_RETRY__.logic === "batch" && activeCount > 1) {
                batchFailed++;
                if (batchFailed === activeCount && !successTriggered) {
                    const batchWait = 500 + Math.floor(Math.random() * 300);
                    logSolver(`[Batch] All ${activeCount} workers failed. Retrying in ${batchWait}ms...`, "#fbbf24");
                    TaskManager.setTimeout("verifyOtp", () => verifyOtpAggressive(mobile, otp, __IVAC_RETRY__, true), batchWait);
                }
            } else {
                TaskManager.setTimeout("verifyOtp", () => worker(id), waitMs);
            }
        };

        try {
            const res = await getGotClient(`VerifyOTP-W${id}`, id).post(`${RootUrl}/iams/api/v1/otp/verifySigninOtp`, {
                json: payload, headers, responseType: "json", signal: controller.signal
            });
            const data = res.body;

            if (res.statusCode === 200 && data?.successFlag && data?.data?.verified) {
                if (data?.data?.accessToken) {
                    authStorage.state.token = data.data.accessToken;
                }
                if (!successTriggered) return handleSuccess(`${wTag} OTP Verified Successfully!`, data);
                return;
            }

            if (res.statusCode === 200 && data?.successFlag && data?.data?.verified === false) {
                TaskManager.removeController("verifyOtp", controller);
                showStatus("OTP Not Valid!", "error");
                logSolver(`${wTag} OTP Not Valid [${data?.statusCode}]`, '#d97706', data);
                TaskManager.setTimeout("GetOtp", () => pollOtpLoop(mobile, __IVAC_RETRY__), 500);
                return;
            }

            if (res.statusCode === 404 || data?.statusCode === 404) {
                TaskManager.stopTask("verifyOtp");
                if (!successTriggered) return handleSuccess("OTP Already Verified!", data);
            }

            if (res.statusCode !== 200 && res.statusCode !== 404) {
                if (!__IVAC_RETRY__?.enabled) {
                    TaskManager.removeController("verifyOtp", controller);
                    if (res.statusCode === 502 || res.statusCode === 504) {
                        logSolver(`OTP Verify Status [${res.statusCode}]`, '#d55252');
                    } else {
                        logSolver(`OTP Verify Status [${res.statusCode}]`, '#d55252', data);
                    }
                    return;
                }
                
                let waitMs = (__IVAC_RETRY__.seconds || 5) * 1000;
                if (res.statusCode === 403 || res.statusCode === 503) {
                    waitMs = 2500 + Math.floor(Math.random() * 501); // 2.5s–3s
                } else if (res.statusCode === 429) {
                    waitMs = 20000; // 20s
                } else if ([500, 501, 502, 504, 520].includes(res.statusCode)) {
                    waitMs = 800 + Math.floor(Math.random() * 401); // 800ms-1200ms
                } else if ([400, 401].includes(res.statusCode)) {
                    waitMs = 1000;
                }
                
                if (res.statusCode === 502 || res.statusCode === 504) {
                    logSolver(`OTP Verify Status [${res.statusCode}]`, '#d55252');
                } else {
                    logSolver(`OTP Verify Status [${res.statusCode}]`, '#d55252', data);
                }
                TaskManager.removeController("verifyOtp", controller);
                onFail(waitMs);
                return;
            }

        } catch (e) {
            if (e.name === "AbortError") return;
            TaskManager.removeController("verifyOtp", controller);
            showStatus(`[verifyOtp #${id}] Verify OTP failed!`, "error");
            logSolver(`OTP Verify Failed!`, '#d55252');
            if (__IVAC_RETRY__?.enabled) onFail(250);
        }
        TaskManager.removeController("verifyOtp", controller);
    };

    if ((!isOtpVerifyAggressive || isBatch) && __IVAC_RETRY__?.mode > 1) {
        isOtpVerifyAggressive = true;
        const numAutoWorkers = parseInt(__IVAC_RETRY__.mode, 10) || 3;
        activeCount = numAutoWorkers;
        verifyOtpWorkerCount = numAutoWorkers;
        const startWorker = (id, delay) => {
            setTimeout(() => { if (!successTriggered) worker(id, 0); }, delay);
        };
        for (let i = 1; i <= numAutoWorkers; i++) {
            let delay = (i === 1) ? 150 : ((i - 1) * 1000 + Math.floor(Math.random() * 201));
            startWorker(i, delay);
        }
    } else {
        activeCount = 1;
        verifyOtpWorkerCount++;
        worker(verifyOtpWorkerCount, 0);
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

async function checkSlot(__IVAC_RETRY__) {
    const taskName = "checkSlot";
    if (TaskManager.tasks[taskName]?.controllers.size) {
        TaskManager.stopTask(taskName);
        showStatus("Check slot aborted", "info");
        finishBtn("checkSlot", "Check Slot", "none");
        return;
    }

    finishBtn("checkSlot", "Loading...");
    showStatus("Checking slot...", "info");

    const token = getAuthToken();
    if (!token) {
        finishBtn("checkSlot", "Check Slot", "none");
        return showStatus("No auth token", "error");
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
                    showStatus("Slot is open!", "success");
                    finishBtn("checkSlot", "Check Slot", "done");
                    logSolver(`Slots Info Received!`, '#16a34a', data);
                    if (!isReserveStarted) {
                        isReserveStarted = true;
                        reserveSlotAggressive(__IVAC_RETRY__);
                    }
                    return;
                }
                if (__IVAC_RETRY__?.enabled) {
                    const waitSec = __IVAC_RETRY__.seconds || 10;
                    showStatus(`Slot not open, Re-checking in ${waitSec}s..`, "error");
                    await new Promise(r => TaskManager.setTimeout(taskName, r, waitSec * 1000));
                    return trySlot();
                }
                return TaskManager.stopTask(taskName);
            }

            if (res.statusCode !== 200) {
                if (res.statusCode === 401) {
                    TaskManager.stopTask(taskName);
                    showStatus(data?.error || "Login session expired!", "error");
                    logSolver(data?.error || "Login session expired!", '#d55252', data);
                    finishBtn("checkSlot", "Check Slot");
                    return;
                }
                if (__IVAC_RETRY__?.enabled) {
                    const waitSec = __IVAC_RETRY__.seconds || 10;
                    showStatus(data?.error || `Checkslot failed. Retrying ${waitSec}s...`, "error");
                    await new Promise(r => TaskManager.setTimeout(taskName, r, waitSec * 1000));
                    return trySlot();
                }
                showStatus(data?.message || "Check Slot Failed", "error");
                logSolver(`CheckSlot Status [${res.statusCode}]`, '#d55252', data);
                finishBtn("checkSlot", "Check Slot");
                return;
            }
        } catch (err) {
            if (err.name !== "AbortError" && __IVAC_RETRY__?.enabled) {
                const waitSec = __IVAC_RETRY__.seconds || 10;
                await new Promise(r => TaskManager.setTimeout(taskName, r, waitSec * 1000));
                return trySlot();
            }
        }
    };
    trySlot();
}

async function reserveSlotAggressive(__IVAC_RETRY__, isBatch = false) {
    finishBtn("reserveSlot", "Reserving...");
    showStatus("Reserve slot is running...", "info");
    const accessToken = getAuthToken();
    if (!accessToken) { finishBtn("reserveSlot", "Reserve Slot", "none"); return showStatus("No Access token", "error"); }

    const headers = {
        "accept": "application/json, text/plain, */*",
        "cache-control": "no-cache, no-store, must-revalidate",
        "authorization": "Bearer " + accessToken,
    };

    let successTriggered = false;

    const handleSuccess = (data) => {
        if (successTriggered) return;
        successTriggered = true;
        reserveSlotWorkerCount = 0;
        TaskManager.stopTask("reserveSlot");
        finishBtn("reserveSlot", "Reserve Slot", "done");
        showStatus("Slot Reserved Successfully!", "success");
        logSolver(`[ RESERVED SUCCESSFULLY ]`, '#16a34a', data);
        UI_SOCKET?.emit("show-reservation-success-popup", { userId: panelConfig.user || "TechBroSniper" });
    };

    let activeCount = 0;
    let batchFailed = 0;

    const worker = async (id, delay = 0, reuseToken = null) => {
        const controller = TaskManager.start("reserveSlot");
        if (delay) await new Promise(r => TaskManager.setTimeout("reserveSlot", r, delay));
        if (successTriggered || controller.signal.aborted) return;

        const wTag = `[W-${id}|${getNetworkTitle(id)}]`;

        const onFail = (waitMs, reuseToken = null) => {
            if (__IVAC_RETRY__.logic === "batch" && activeCount > 1) {
                batchFailed++;
                if (!worker.maxBatchWait || waitMs > worker.maxBatchWait) {
                    worker.maxBatchWait = waitMs;
                }
                if (batchFailed === activeCount && !successTriggered) {
                    const batchWait = worker.maxBatchWait > 5000 ? worker.maxBatchWait : 500 + Math.floor(Math.random() * 300);
                    worker.maxBatchWait = 0;
                    logSolver(`[Batch] All ${activeCount} workers failed. Retrying in ${batchWait}ms...`, "#fbbf24");
                    TaskManager.setTimeout("reserveSlot", () => reserveSlotAggressive(__IVAC_RETRY__, true), batchWait);
                }
            } else {
                TaskManager.setTimeout("reserveSlot", () => worker(id, 0, reuseToken), waitMs);
            }
        };

        let recapToken;
        if (reuseToken) {
            recapToken = reuseToken;
        } else {
            let newToken = await solveAggressive();
            if (newToken) { 
                recapToken = encryptCaptchaToken(newToken);
                worker.tokenTimestamp = Date.now();
                logSolver(`${wTag} ReserveSlot Started`, "#3b82f6");
            } else { finishBtn("reserveSlot", "Reserve Slot", "none"); return showStatus("Auto captcha solve failed!", "error"); }
        }

        try {
            const res = await getGotClient(`ReserveSlot-W${id}`, id).post(`${RootUrl}/iams/api/v1/slots/reserveSlot`, {
                json: { captchaToken: recapToken }, headers, responseType: "json", signal: controller.signal,
                context: { workerId: id }
            });
            const data = res.body;

            if (res.statusCode === 200 && ["OK_NEW", "OK_EXISTING"].includes(data?.status) && data?.reservationId) {
                logSolver(`${wTag} Slot Reserved Successfully`, '#16a34a', data);
                return handleSuccess(data);
            }

            if (res.statusCode === 200 && ["FULL", "NOT_OPEN", "SLOT_NOT_PREPARED"].includes(data?.status)) {
                const wait = __IVAC_RETRY__.seconds || 10;
                logSolver(`${wTag} Slot Status [ ${data?.status} ]`, '#b057ff', data);
                
                queueToken(); // Trigger solve in background if pool empty

                logSolver(`${wTag} ReserveSlot Next Hit ${wait}s`);
                TaskManager.removeController("reserveSlot", controller);
                return onFail(wait * 1000, null);
            }

            if (res.statusCode !== 200) {
                 if (res.statusCode === 401) {
                     const bdTime = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Dhaka" }));
                     const isOver510PM = (bdTime.getHours() > 17) || (bdTime.getHours() === 17 && bdTime.getMinutes() >= 10);
                     
                     if (isOver510PM) {
                         TaskManager.stopAll();
                         logSolver(`ReserveSlot 401 Expired (After 5:10 PM). Auto Re-login...`, '#dc2626');
                         showStatus("Session Expired, auto re-login...", "error");
                         if (panelConfig.saved_mobile && panelConfig.saved_password) {
                             workerNetworkClients.clear();
                             tlsSessionCache.clear();
                             sendOtp(panelConfig.saved_email || null, panelConfig.saved_mobile, panelConfig.saved_password, __IVAC_RETRY__);
                         }
                         return;
                     } else {
                         logSolver(`ReserveSlot 401 (Before 5:10 PM) -> Treating as Server Error (Retry)`, '#b057ff');
                     }
                 }

                 if (res.statusCode === 503 && data?.data == null) {
                     logSolver(`ReserveSlot Disabled [${res.statusCode}]`,'#d55252');
                     TaskManager.stopTask("reserveSlot");
                     return;
                 }

                 if (!__IVAC_RETRY__?.enabled) {
                     TaskManager.stopTask("reserveSlot");
                     finishBtn("reserveSlot", "Reserve Slot", "none");
                     if (res.statusCode === 403 || res.statusCode === 502 || res.statusCode === 504) {
                         logSolver(`ReserveSlot Status [${res.statusCode}]`, '#d55252');
                     } else {
                         logSolver(`ReserveSlot Status [${res.statusCode}]`, '#d55252', data);
                     }
                     showStatus(data?.message || "Check Slot Failed", "error");
                     return;
                 }
                 
                 let waitMs = (__IVAC_RETRY__.seconds || 5) * 1000;
                 if (res.statusCode === 403 || res.statusCode === 503) waitMs = 2500 + Math.floor(Math.random() * 501); // 2.5s-3s
                 else if (res.statusCode === 429) waitMs = 20000; // 20s
                 else if ([500, 501, 520, 401].includes(res.statusCode)) waitMs = 800 + Math.floor(Math.random() * 401); // 800ms-1200ms
                 else if (res.statusCode === 502 || res.statusCode === 504) {
                     // Cool-Down Retry for 502/504
                     waitMs = 800 + Math.floor(Math.random() * 701); // 800ms - 1500ms
                 }
                 else if ([400].includes(res.statusCode)) waitMs = 1000;

                 if (res.statusCode === 403) {
                     logSolver(`${wTag} Slot Status [ 403 ] -> Hard Resetting Session`, '#b057ff');
                     clearWorkerClient(`ReserveSlot-W${id}`, id);
                     clearTlsSession("api.ivacbd.com");
                 } else if (res.statusCode === 502 || res.statusCode === 504) {
                     logSolver(`${wTag} Slot Status [ ${res.statusCode} ] -> Cool-Down Retry`, '#b057ff');
                 } else {
                     logSolver(`${wTag} Slot Status [ ${res.statusCode} ]`, '#b057ff', data);
                 }

                 TaskManager.removeController("reserveSlot", controller);
                 
                 if ([502, 504].includes(res.statusCode)) {
                      // Smart Token Life Management for 502/504
                      const tokenAge = Date.now() - worker.tokenTimestamp;
                      if (tokenAge < 3000 && tokenAge < 70000) {
                           logSolver(`${wTag} Reusing token (Age: ${(tokenAge/1000).toFixed(1)}s) in ${(waitMs/1000).toFixed(2)}s`);
                           return onFail(waitMs, recapToken);
                      } else {
                           logSolver(`${wTag} Requesting fresh token in ${(waitMs/1000).toFixed(2)}s`);
                           return onFail(waitMs, null);
                      }
                 }

                 if ([403, 503, 429].includes(res.statusCode)) {
                      logSolver(`${wTag} Next Hit ${(waitMs/1000).toFixed(2)}s`);
                      return onFail(waitMs, null);
                  }

                  queueToken(); // Trigger solve in background
                  logSolver(`${wTag} Next Hit ${(waitMs/1000).toFixed(2)}s`);
                  return onFail(waitMs, null);
            }


        } catch (e) {
            if (e.name === "AbortError") return;
            TaskManager.removeController("reserveSlot", controller);
            if (__IVAC_RETRY__?.enabled) {
                const wait = __IVAC_RETRY__.seconds || 10;
                logSolver(`ReserveSlot Status Cross/Error`, '#b057ff');
                queueToken();
                logSolver(`${wTag} ReserveSlot Next Hit ${wait}s`);
                return onFail(wait * 1000, null);
            }
        }
    };

    // logSolver('Reserve Slot Started....');
    
    let numWorkersToStart = 1;
    if ((reserveSlotWorkerCount === 0 || isBatch) && __IVAC_RETRY__?.mode > 1) {
        numWorkersToStart = parseInt(__IVAC_RETRY__.mode, 10) || 3;
    }
    activeCount = numWorkersToStart;
    if (isBatch) reserveSlotWorkerCount = 0;

    let currentDelay = 0;
    for (let i = 0; i < numWorkersToStart; i++) {
        reserveSlotWorkerCount++;
        const currentId = reserveSlotWorkerCount;
        setTimeout(() => {
            if (!successTriggered) worker(currentId, 0);
        }, currentDelay);
        currentDelay += Math.floor(Math.random() * 201) + 150;
    }
}

async function payNow(__IVAC_RETRY__, isBatch = false) {
    // logSolver(`Pay Now Setup Initialized...`, '#3b82f6');
    const accessToken = getAuthToken();
    if (!accessToken) { showStatus("No auth token", "error"); finishBtn("payNow", "Pay Now", "none"); return; }
    
    finishBtn("payNow", "Loading...");
    showStatus("Initiating payment...", "info");

    let successTriggered = false;

    let activeCount = 0;
    let batchFailed = 0;

    const worker = async (id, delay = 0) => {
        const controller = TaskManager.start("payNow");
        if (delay) await new Promise(r => TaskManager.setTimeout("payNow", r, delay));
        if (successTriggered || controller.signal.aborted) return;

        const wTag = `[W-${id}|${getNetworkTitle(id)}]`;
        logSolver(`${wTag} PayNow Hit Started...`, "#3b82f6");

        const onFail = (waitMs) => {
            if (__IVAC_RETRY__.logic === "batch" && activeCount > 1) {
                batchFailed++;
                if (batchFailed === activeCount && !successTriggered) {
                    const batchWait = 500 + Math.floor(Math.random() * 300);
                    logSolver(`[Batch] All ${activeCount} workers failed. Retrying in ${batchWait}ms...`, "#fbbf24");
                    TaskManager.setTimeout("payNow", () => payNow(__IVAC_RETRY__, true), batchWait);
                }
            } else {
                TaskManager.setTimeout("payNow", () => worker(id), waitMs);
            }
        };

        try {
            const res = await getGotClient(`PayNow-W${id}`, id).post(`${RootUrl}/iams/api/v1/payment/ssl/initiate`, {
                headers: { "accept": "application/json, */*", "authorization": "Bearer " + accessToken },
                responseType: "json", signal: controller.signal, timeout: { request: 120000 }
            });
            const data = res.body;

            if (res.statusCode >= 200 && res.statusCode < 300 && data?.data?.redirectGatewayURL) {
                if (successTriggered) return;
                successTriggered = true;

                showStatus("Payment link generated!", "success");
                UI_SOCKET?.emit("payment-link", { url: data.data.redirectGatewayURL, userId: panelConfig.user || "TechBroSniper" });
                TaskManager.stopTask("payNow");
                finishBtn("payNow", "Pay Now", "done");
                logSolver(`${wTag} ✔ [ PAYMENT LINK GENERATED ]`, '#16a34a', data);
                return;
            }

            if ([401].includes(res.statusCode)) {
                if (!successTriggered) {
                    successTriggered = true;
                    showStatus(data?.error || "Login session expired!", "error");
                    logSolver(`${wTag} ${data?.error || "Login session expired!"}`, '#d55252', data);
                    TaskManager.stopTask("payNow");
                    finishBtn("payNow", "Pay Now", "none");
                }
                return;
            }

            if ([400, 404].includes(res.statusCode)) {
                if (!successTriggered) {
                    successTriggered = true;
                    showStatus(data?.message || data?.error || "Payment SSL failed!", "error");
                    logSolver(`${wTag} [ RESERVATION NOT FOUND ]`, '#9333ea', data);
                    TaskManager.stopTask("payNow");
                    finishBtn("payNow", "Pay Now", "none");
                }
                return;
            }

            if (__IVAC_RETRY__?.enabled) {
                let waitMs = (__IVAC_RETRY__.seconds || 5) * 1000;
                if ([403, 503].includes(res.statusCode)) waitMs = 2500 + Math.floor(Math.random() * 501);
                else if (res.statusCode === 429) waitMs = 20000; // 20s
                else if ([502, 504, 520].includes(res.statusCode)) waitMs = 800 + Math.floor(Math.random() * 401); // 800ms-1200ms

                logSolver(`${wTag} Payment retry [${res.statusCode}] in ${waitMs}ms`, '#d55252', data);
                TaskManager.removeController("payNow", controller);
                return onFail(waitMs);
            }

            TaskManager.removeController("payNow", controller);
        } catch (err) {
            if (err.name !== "AbortError" && __IVAC_RETRY__?.enabled) {
                logSolver(`${wTag} Payment network error`, '#d55252');
                TaskManager.removeController("payNow", controller);
                return onFail(1000);
            }
            TaskManager.removeController("payNow", controller);
        }
    };

    let numWorkers = 1;
    if (__IVAC_RETRY__?.mode > 1) {
        numWorkers = parseInt(__IVAC_RETRY__.mode, 10) || 3;
    }
    activeCount = numWorkers;

    const startWorker = (id, delay) => {
        setTimeout(() => { if (!successTriggered) worker(id, 0); }, delay);
    };

    for (let i = 1; i <= numWorkers; i++) {
        let delay = (i === 1) ? 150 : ((i - 1) * 1000 + Math.floor(Math.random() * 201));
        startWorker(i, delay);
    }
}


// ==========================================
// SOCKET ROUTES
// ==========================================
io.on("connection", (socket) => {
    socket.authenticated = false;
    UI_SOCKET = socket;
    console.log("UI Connected:", socket.id);

    const secure = (handler) => (data, cb) => {
        if (!socket.authenticated) {
            socket.emit("status", { msg: "Unauthorized!", type: "error" });
            if (typeof cb === "function") cb(false);
            return;
        }
        return handler(data, cb);
    };

    socket.on("stop-all", secure(() => {
        TaskManager.stopAll();
        sendOtpWorkerCount = 0;
        verifyOtpWorkerCount = 0;
        reserveSlotWorkerCount = 0;
        showStatus("Stopped All Backend Tasks", "error");
    }));
    
    socket.on("panel-login", (data, cb) => {
        if (data?.user === panelConfig.user && data?.pass === panelConfig.pass) {
            socket.authenticated = true;
            const token = generateSessionToken();
            cb({ success: true, token });
            socket.emit("initial-config", {
                mobile: panelConfig.saved_mobile || "",
                email: panelConfig.saved_email || "",
                password: panelConfig.saved_password || "",
                capInfo: panelConfig.capInfo || { type: null, key: null },
                directApi: directApi
            });
        } else {
            cb({ success: false });
        }
    });

    socket.on("panel-session-login", (data, cb) => {
        if (data?.token && data.token === currentSessionToken && Date.now() < sessionExpiry) {
            socket.authenticated = true;
            cb(true);
            socket.emit("initial-config", {
                mobile: panelConfig.saved_mobile || "",
                email: panelConfig.saved_email || "",
                password: panelConfig.saved_password || "",
                capInfo: panelConfig.capInfo || { type: null, key: null },
                directApi: directApi
            });
        } else {
            cb(false);
        }
    });

    socket.on("save-file-info", secure((data) => {
        panelConfig.saved_mobile = data.mobile;
        panelConfig.saved_email = data.email;
        panelConfig.saved_password = data.password;
        fs.writeFileSync(path.join(__dirname, "config.json"), JSON.stringify(panelConfig, null, 2));
    }));
    
    socket.on("send-otp", secure((data) => { sendOtp(data.email, data.mobile, data.mbpassword, data.retrySettings, data.oldOtp); }));
    socket.on("verify-otp", secure((data) => { verifyOtpAggressive(data.mobile, data.otp, data.retrySettings); }));
    socket.on("reserve-slot", secure((data) => { reserveSlotAggressive(data.retrySettings); }));
    socket.on("pay-now", secure((data) => { payNow(data.retrySettings); }));
    
    socket.on("get-session-data", secure(() => {
        if (authStorage.state.isAuthenticated || authStorage.state.token) {
            socket.emit("receive-session-data", authStorage);
        }
    }));

    socket.on("get-otp", secure((data) => { pollOtpLoop(data.mobile, data.retrySettings, true); }));
    socket.on("reserve-otp", secure((data) => { reserveOtp(data.email,data.mobile, data.retrySettings, data.isPreWarmup); }));
    socket.on("pre-solve-batch", secure((count) => {
        for (let i = 0; i < count; i++) {
            queueToken();
        }
    }));
    socket.on("check-slot", secure((data) => { checkSlot(data.retrySettings); }));
    socket.on("check-file", secure(() => { checkFile(socket); }));
    socket.on("upload-file", secure((data) => { uploadFile(socket, data); }));
    socket.on("cap-settings", secure((data) => { 
        CapInfo = data; 
        panelConfig.capInfo = data;
        fs.writeFileSync(path.join(__dirname, "config.json"), JSON.stringify(panelConfig, null, 2));
        logSolver("Server received new Captcha Settings.", "#10b981"); 
    }));

    socket.on("update-direct-api", secure((val) => {
        setDirectApi(val);
        const activeDns = directApi ? "Direct Router API" : (dnsMap["api.ivacbd.com"] || "Default API");
        logSolver(`🌐 Reservation DNS IP: ${activeDns}`, "#10b981");
    }));
    socket.on("proxy-state", secure((state) => { 
        currentProxyState = state; 
        workerNetworkClients.clear(); 
        logSolver(`✔ Proxy Engine mapped to: ${state.activeMode}`, "#3b82f6"); 
        const activeDns = directApi ? "Direct Router API" : (dnsMap["api.ivacbd.com"] || "Default API");
        logSolver(`🌐 Reservation DNS IP: ${activeDns}`, "#10b981");
    }));
    
    socket.on("test-proxy", secure(async (data) => {
        const { index, proxy } = data;
        const startTime = performance.now();
        const credentials = (proxy.user && proxy.pass) ? `${proxy.user}:${proxy.pass}@` : "";
        const proxyUrl = `http://${credentials}${proxy.host}:${proxy.port}`;
        
        try {
            const res = await gotScraping.get(`${RootUrl}/iams/api/v1/slots/getVisaCenter`, {
                proxyUrl: proxyUrl,
                timeout: { request: 10000 },
                throwHttpErrors: false,
                retry: { limit: 0 }
            });
            const ms = Math.floor(performance.now() - startTime);
            socket.emit("test-proxy-result", { index, success: true, status: res.statusCode, ms });
        } catch (e) {
            socket.emit("test-proxy-result", { index, success: false, status: e.code || e.message || "Error" });
        }
    }));
    
    socket.on("hard-reset", secure(() => {
        TaskManager.stopAll();
        workerNetworkClients.clear();
        currentProxyState.activeMode = "native";
        preSolvedTokens = [];
        solversInProgress = 0;
        PRE_FETCHED_OTP = null;
        lastGetOtp = [];
        isReserveOtpSend = false;
        isReserveStarted = false;
        isOtpVerifyAggressive = false;
        pollingOtp = false;
        globalOtpVerified = false;
        sendOtpWorkerCount = 0;
        verifyOtpWorkerCount = 0;
        reserveSlotWorkerCount = 0;
        
        authStorage.state = {
            token: null,
            expiresAt: 899,
            isAuthenticated: false,
            isVerified: false,
            phone: null,
            password: null,
            requestId: null,
            userId: null,
            otpSentAt: null
        };
        
        socket.emit("hide-export-session");
        io.emit("solver-clear");
        const activeDns = directApi ? "Direct Router API" : (dnsMap["api.ivacbd.com"] || "Default API");
        logSolver("> ==============================", "#10b981");
        logSolver("> SOFTWARE Restart successfully", "#10b981");
        logSolver(`> Reservation DNS IP: ${activeDns}`, "#10b981");
        logSolver("> ==============================", "#10b981");
        showStatus("Server System Reset", "success");
    }));
    
    socket.on("git-update", secure(() => {
        logSolver("🚀 Initiating System Update via script...", "#3b82f6");
        
        const scriptPath = path.join(__dirname, "update.js");
        const updateProcess = spawn("node", [scriptPath], { cwd: __dirname });

        updateProcess.stdout.on("data", (data) => {
            data.toString().split("\n").forEach(line => {
                if (line.trim()) logSolver(line, "#10b981");
            });
        });

        updateProcess.stderr.on("data", (data) => {
            data.toString().split("\n").forEach(line => {
                if (line.trim()) logSolver(line, "#ef4444");
            });
        });

        updateProcess.on("close", (code) => {
            if (code !== 0) {
                logSolver(`❌ Update Process exited with code ${code}`, "#ef4444");
            } else {
                logSolver("✅ System Update Cycle Completed.", "#10b981");
            }
        });
    }));
    
    socket.on("pre-solve", secure(() => { queueToken(); }));
    socket.on("pre-solve-batch", secure((size = 2) => { 
        for(let i=0; i<size; i++) queueToken(); 
    }));
    socket.on("sms-list", secure(async (data) => {
        if (!data.mobile) return showStatus("Enter Mobile Number", "error");
        try {
            const res = await gotScraping(`https://sms.mrshuvo.xyz/ivac/${data.mobile}`, { responseType: "json" });
            const body = res.body;
            if (body?.success && body?.data?.otp) {
                showStatus(`Latest SMS: ${body.data.otp}`, "success");
                logSolver(`SMS Data: ${JSON.stringify(body.data)}`, '#3b82f6');
            } else {
                showStatus("No recent SMS found", "error");
            }
        } catch (e) {
            showStatus("Failed to fetch SMS", "error");
        }
    }));
});

const PORT = panelConfig.port || 5000;
const IP = panelConfig.ip || '0.0.0.0';
server.listen(PORT, IP, () => {
    console.log(`🎯 IVAC High-Speed Engine running perfectly on http://${IP}:${PORT}`);
});
