import { spawn } from "child_process";
import express from "express";
import fs from "fs";
import { gotScraping } from "got-scraping";
import { createServer } from "http";
import path from "path";
import { Server } from "socket.io";
import { fileURLToPath } from "url";
import { directApi, dnsMap } from "./dnsconfig.js";
import { encryptCaptchaToken } from "./tokenEncrypt.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

let panelConfig = { user: "admin", pass: "admin123", ip: "0.0.0.0", port: 5000, main_ip: "", additional_ips: [] };
try {
    const cf = fs.readFileSync(path.join(__dirname, "config.json"), "utf8");
    panelConfig = { ...panelConfig, ...JSON.parse(cf) };
} catch (e) {
    fs.writeFileSync(path.join(__dirname, "config.json"), JSON.stringify(panelConfig, null, 2));
}

let currentProxyState = { activeMode: "native", proxies: [] };

function getNetworkOpts(workerId = null) {
    const baseOpts = {
        https: { rejectUnauthorized: false }
    };

    if (!currentProxyState) return baseOpts;
    
    if (currentProxyState.activeMode === "private") {
        const ip = getLocalAddress(workerId);
        if (ip && ip !== "0.0.0.0") return { ...baseOpts, localAddress: ip };
    }
    
    // In "native" mode, bind to main_ip if configured
    if (currentProxyState.activeMode === "native" && panelConfig?.main_ip && panelConfig.main_ip !== "0.0.0.0") {
        return { ...baseOpts, localAddress: panelConfig.main_ip };
    }
    
    return baseOpts;
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
        // Isolated Instance per worker (Random or Multi-IP Private)
        const pUrl = getProxyUrl(taskName, workerId, true);
        key = `${activeMode}-${workerId}-${pUrl || 'none'}`;
    } else {
        // Unified Shared Instance (Native, Specific Proxy, or Single-IP Private)
        const pUrl = getProxyUrl(taskName, null, true);
        key = `${activeMode}-shared-${pUrl || 'none'}`;
        effectiveWorkerId = 1; 
    }

    const proxyUrl = getProxyUrl(taskName, effectiveWorkerId, true);
    const netOpts = getNetworkOpts(effectiveWorkerId);
    
    if (!workerNetworkClients.has(key)) {
        const client = gotScraping.extend({
            http2: true,
            throwHttpErrors: false,
            retry: { limit: 0 },
            timeout: { 
                request: 120000, 
                connect: 30000 
            },
            proxyUrl: proxyUrl,
            hooks: {
                beforeRequest: [
                    (options) => {
                        // Selective DNS Overriding logic for HTTP/2 compatibility
                        const path = options.url.pathname;
                        const isReservation = path === '/iams/api/v1/slots/reserveSlot';
                        const originalHost = "api.ivacbd.com";
                        const fixedIp = dnsMap[originalHost];

                        if (!directApi && isReservation && fixedIp) {
                            // Ensure hostname is the fixed IP
                            options.url.hostname = fixedIp;
                            
                            // Always explicitly set host header and SNI for the pinned IP
                            options.headers.host = originalHost;
                            options.https = options.https || {};
                            options.https.serverName = originalHost;
                            
                            const actualId = options.context?.workerId || workerId;
                            const wTag = `[W-${actualId || 1}|${getNetworkTitle(actualId)}]`;
                            logSolver(`${wTag} DNS Pinning -> ${fixedIp}`, "#8b5cf6");
                        }

                        const host = options.url.host;
                        if (tlsSessionCache.has(host)) {
                            options.https = options.https || {};
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
                        if (host && tlsSessionCache.has(host)) {
                            // If a connection error occurs, clear the session to ensure a fresh handshake next time
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

let captchaToken = null;
let captchaCreatedAt = 0;
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

let CapInfo = { type: null, key: null };
const TRANSIT_SITE_KEY = "0x4AAAAAACghKkJHL1t7UkuZ";
const SITE_URL = "https://appointment.ivacbd.com";

async function startWorkerCapMonoster(id, signal) {
    const API = "https://api.capmonster.cloud";
    try {
        if (signal?.aborted) return null;
        // logSolver(`[Worker #${id}] CapMonster Task Started`, "#f59e0b");
        
        const create = await gotScraping.post(`${API}/createTask`, {
            json: {
                clientKey: CapInfo.key,
                task: { type: "TurnstileTaskProxyless", websiteURL: SITE_URL, websiteKey: TRANSIT_SITE_KEY }
            },
            responseType: "json", signal
        });
        
        const { taskId, errorId, errorDescription } = create.body;
        if (errorId !== 0) throw new Error(errorDescription || "Create Task Failed");
        
        while (!signal?.aborted) {
            await new Promise(r => setTimeout(r, 800));
            if (signal?.aborted) return null;
            
            const check = await gotScraping.post(`${API}/getTaskResult`, {
                json: { clientKey: CapInfo.key, taskId },
                responseType: "json", signal
            });
            const result = check.body;
            
            if (result.errorId && result.errorId !== 0) throw new Error(result.errorDescription || "Task failed");
            if (result.status === "ready" && result.solution?.token) return result.solution.token;
            if (result.status === "failed") throw new Error("Task failed");
        }
    } catch (err) {
        if (err.name !== "AbortError") logSolver(`CapMonster Worker ${id} Failed: ${err.message}`, "#ef4444");
    }
    return null;
}

async function startWorkerCapSolver(id, signal) {
    const API = "https://api.capsolver.com";
    try {
        if (signal?.aborted) return null;
        // logSolver(`[Worker #${id}] CapSolver Task Started`, "#f59e0b");
        
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
        while (!signal?.aborted) {
            await new Promise(r => setTimeout(r, 800));
            if (signal?.aborted) return null;
            
            const check = await gotScraping.post(`${API}/getTaskResult`, {
                json: { clientKey: CapInfo.key, taskId },
                responseType: "json", signal
            });
            const result = check.body;
            
            if (result.errorId && result.errorId !== 0) throw new Error(result.errorDescription || "Task failed");
            if (result.status === "ready" && result.solution?.token) return result.solution.token;
            if (result.status === "failed") throw new Error("Task failed");
        }
    } catch (err) {
        if (err.name !== "AbortError") logSolver(`CapSolver Worker ${id} Failed: ${err.message}`, "#ef4444");
    }
    return null;
}

let preSolvedTokens = [];
let PRE_FETCHED_OTP = null;

async function queueToken() {
    // logSolver("Pre-solving captcha started...", "#3b82f6");
    UI_SOCKET?.emit("btn-reset", { id: "solver", text: "Solving API..." });
    const token = await __solveAggressive();
    if (token) {
        preSolvedTokens.push({ token, time: Date.now() });
        // logSolver(`Captcha Reserved! [POOL-${preSolvedTokens.length}]`, "#10b981");
        UI_SOCKET?.emit("btn-reset", { id: "solver", text: `🧩 Solver (${preSolvedTokens.length})` });
        return true;
    } else {
        UI_SOCKET?.emit("btn-reset", { id: "solver", text: preSolvedTokens.length > 0 ? `🧩 Solver (${preSolvedTokens.length})` : "🧩 Solver" });
    }
    return false;
}

async function solveAggressive() {
    while (preSolvedTokens.length > 0) {
        const item = preSolvedTokens.shift();
        if (Date.now() - item.time <= 80000) {
            // logSolver(`Consumed a pre-solved token. Remaining: ${preSolvedTokens.length}`, "#f59e0b");
            UI_SOCKET?.emit("btn-reset", { id: "solver", text: preSolvedTokens.length > 0 ? `🧩 Solver (${preSolvedTokens.length})` : "🧩 Solver" });
            return item.token;
        } else {
            // logSolver(`Removed expired Captcha token (>80s).`, "#dc2626");
            UI_SOCKET?.emit("btn-reset", { id: "solver", text: preSolvedTokens.length > 0 ? `🧩 Solver (${preSolvedTokens.length})` : "🧩 Solver" });
        }
    }
    return await __solveAggressive();
}

async function __solveAggressive() {
    logSolver("🧩 API Captcha Solving...", "#3b82f6");
    if (!CapInfo?.type || !CapInfo?.key) {
        logSolver("No Cap API keys set! Auto solve disabled.", "#dc2626");
        return null;
    }
    
    const taskName = "captchaSolver";
    const controller = TaskManager.start(taskName);
    const { signal } = controller;
    
    let workerPromises = [];
    if (CapInfo.type === "capSolver") {
        workerPromises.push(startWorkerCapSolver(1, signal));
    } else {
        workerPromises.push(startWorkerCapMonoster(1, signal));
    }
    
    try {
        const token = await Promise.any(workerPromises.filter(p => p !== null));
        if (token && !signal.aborted) {
            TaskManager.removeController(taskName, controller);
            logSolver(`🧩 API Token Solved.`, "#10b981");
            return token;
        }
    } catch (e) {
        if (!signal.aborted) logSolver(`⚠️ API Captcha Solve Failed`, "#ef4444");
    } finally {
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
            
            const token = getAuthToken();
            if (token && !isReserveOtpSend && __IVAC_RETRY__?.enabled) {
                const otpToUse = PRE_FETCHED_OTP || foundOtp;
                PRE_FETCHED_OTP = null;
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

async function reserveOtp(email,mobile, __IVAC_RETRY__) {
    finishBtn("reserveOtp", "Sending...");
    showStatus("Sending OTP...", "info");
    // logSolver(`Reserve OTP Setup Initialized...`, '#3b82f6');

    sendOtpWorkerCount++;
    const workerId = sendOtpWorkerCount;
    const taskName = `ReserveOtp-${workerId}`;
    const controller = TaskManager.start(taskName);

    if (!email) {
        TaskManager.stopTask(taskName);
        return showStatus("Email required", "error");
    }

    const payload = { email, "otpChannel": "PHONE" };
    const startTime = performance.now();

    const trySend = async () => {
        if (controller.signal.aborted) return;
        
        if (performance.now() - startTime > 20000) {
            TaskManager.stopTask(taskName);
            finishBtn("reserveOtp", "Reserve OTP");
            showStatus("Reserve OTP Timed Out (>20s)", "error");
            logSolver(`[W-${workerId}] Reserve OTP Terminated (20s Timeout)`, "#dc2626");
            return;
        }

        const wTag = `[W-${workerId}|${getNetworkTitle(workerId)}]`;
        logSolver(`${wTag} ReserveOTP Started`, "#3b82f6");
        try {
            const res = await getGotClient(`ReserveOTP-W${workerId}`, workerId).post(`${RootUrl}/iams/api/v1/forgot-password/sendOtp`, {
                json: payload, responseType: "json", signal: controller.signal,
                headers: { "accept": "application/json, text/plain, */*", "cache-control": "no-cache, no-store, must-revalidate" }
            });

            const data = res.body;

            const wTag = `[W-${workerId}|${getNetworkTitle(workerId)}]`;

            if (res.statusCode === 200 && data?.successFlag) {
                TaskManager.stopTask(taskName);
                finishBtn("reserveOtp", "Reserve OTP", "done");
                showStatus(`ReserveOtp Send Successfully`, "success");
                logSolver(`${wTag} ReserveOtp Send Success`, '#16a34a', data);

                sendOtpWorkerCount = 0;
                authStorage.state.userId = data.data?.userId;
                authStorage.state.requestId = data.data?.requestId;
                authStorage.state.phone = mobile;
                authStorage.state.otpSentAt = Date.now();
                isReserveOtpSend = true;
                TaskManager.setTimeout('GetOtp', () => pollOtpLoop(mobile, __IVAC_RETRY__), 1000);
                
                return;
            }

            if (res.statusCode !== 200) {
                if (!__IVAC_RETRY__?.enabled) {
                    TaskManager.removeController(taskName, controller);
                    finishBtn("reserveOtp", "Reserve OTP");
                    logSolver(`Reserve OTP Status [${res.statusCode}]`, '#d55252', data);
                    return showStatus(data?.message || data?.error || "Failed", "error");
                }
                let waitMs = (__IVAC_RETRY__.seconds || 5) * 1000;
                if (res.statusCode === 403 || res.statusCode === 503) {
                    waitMs = 2500 + Math.floor(Math.random() * 501); // 2.5s–3s
                }else if ([500, 501, 502, 504, 520].includes(res.statusCode))      waitMs = 500 + Math.floor(Math.random() * 1000); // 1s–1.5s
                else if ([400, 401].includes(res.statusCode)) waitMs = 1000;
                
                logSolver(`${wTag} ReserveOTP Status [${res.statusCode}] -> Retry in ${waitMs}ms`, '#d55252', data);
                return TaskManager.setTimeout(taskName, trySend, waitMs);
            }

            finishBtn("reserveOtp", "Reserve OTP");
            TaskManager.removeController(taskName, controller);
        } catch (err) {
            if (err.name !== "AbortError" && __IVAC_RETRY__?.enabled) {
                logSolver(`${wTag} Send OTP Cross Error: ${err.message}`, '#d55252');
                return TaskManager.setTimeout(taskName, trySend, 1000);
            }
            TaskManager.removeController(taskName, controller);
            finishBtn("reserveOtp", "Reserve OTP");
        }
    };
    trySend();
}

async function sendOTPWarmUp(mobile, mbpassword, workers) {
    const taskName = `sendOTPWarmUp`;
    const controller = TaskManager.start(taskName);

    if (!mobile || !mbpassword) {
        TaskManager.stopTask(taskName);
        return logSolver(`Phone & Password required`, "#d55252");
    }

    const trySend = async (workerId) => {
        if (controller.signal.aborted) return;
        const wTag = `[W-${workerId}|${getNetworkTitle(workerId)}]`;
        logSolver(`${wTag} SendOTP WarmUp Started`, "#3b82f6");
        try {
            const now = Date.now();
            const expired = (now - captchaCreatedAt) > CAPTCHA_TTL;

            let tokenToUse;
            if (!captchaToken || expired) {
                captchaToken = await solveAggressive();
                captchaCreatedAt = Date.now();
                tokenToUse = captchaToken;
            } else {
                tokenToUse = captchaToken;
            }

            const payload = { captchaToken: tokenToUse, phone: mobile, password: mbpassword };

            const response = await getGotClient(`WarmUp-W${workerId}`, workerId).post(`${RootUrl}/iams/api/v1/auth/signin`, {
                json: payload, responseType: "json", signal: controller.signal,
                headers: { "accept": "application/json, text/plain, */*", "cache-control": "no-cache, no-store, must-revalidate" },
                throwHttpErrors: false
            });

            const data = response.body;

            if (response.statusCode === 200 && data?.successFlag) {
                logSolver(`${wTag} WarmUp Request Successfully`, '#16a34a', data);
            } else {
                if (response.statusCode === 403) {
                    logSolver(`${wTag} Send OTP WarmUp Status [403]`, '#d55252');
                } else {
                    logSolver(`${wTag} Send OTP WarmUp Status [${response.statusCode}]`, '#d55252', data);
                }
            }
            TaskManager.removeController(taskName, controller);
        } catch (err) {
            if (err.name !== "AbortError") {
                logSolver(`${wTag} Send OTP WarmUp Cross Error: ${err.message}`, '#d55252');
            }
            TaskManager.removeController(taskName, controller);
        }
    };

    for (let i = 1; i <= workers; i++) {
        trySend(i);
    }
}

async function sendOtp(mobile, mbpassword, __IVAC_RETRY__, oldOtpBoxValue) {
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
    const workerId = sendOtpWorkerCount;
    const taskName = `sendOtp-${workerId}`;
    const controller = TaskManager.start(taskName);

    if (!mobile || !mbpassword) {
        TaskManager.stopTask(taskName);
        return showStatus("Phone & Password required", "error");
    }

    const trySend = async (workerId, oldTokenToUse = null) => {
        if (controller.signal.aborted) return;
        const wTag = `[W-${workerId}|${getNetworkTitle(workerId)}]`;
        logSolver(`${wTag} SendOTP Started`, "#3b82f6");
        try {
            const now = Date.now();
            const expired = (now - captchaCreatedAt) > CAPTCHA_TTL;

            let tokenToUse;
            if (oldTokenToUse) {
                tokenToUse = oldTokenToUse;
            } else if (!captchaToken || expired) {
                captchaToken = await solveAggressive();
                captchaCreatedAt = Date.now();
                tokenToUse = captchaToken;
            } else {
                tokenToUse = captchaToken;
            }

            const payload = { captchaToken: tokenToUse, phone: mobile, password: mbpassword };

            const response = await getGotClient(`SendOTP-W${workerId}`, workerId).post(`${RootUrl}/iams/api/v1/auth/signin`, {
                json: payload, responseType: "json", signal: controller.signal,
                headers: { "accept": "application/json, text/plain, */*", "cache-control": "no-cache, no-store, must-revalidate" }
            });

            const data = response.body;

            const wTag = `[W-${workerId}|${getNetworkTitle(workerId)}]`;

            if (response.statusCode === 200 && data?.successFlag) {
                TaskManager.stopTask(taskName);
                finishBtn("sendOtp", "Send OTP", "done");
                showStatus(`OTP Send Successfully`, "success");
                logSolver(`${wTag} OTP Send Successfully`, '#16a34a', data);

                sendOtpWorkerCount = 0;
                isReserveStarted = false;
                isOtpVerifyAggressive = false;
                globalOtpVerified = false;
                captchaToken = null;

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
                if (![403, 503, 429].includes(response.statusCode)) {
                    captchaToken = null;
                }
                if (!__IVAC_RETRY__?.enabled) {
                    TaskManager.removeController(taskName, controller);
                    finishBtn("sendOtp", "Send OTP", "none");
                    if (response.statusCode === 403) {
                        logSolver(`Send OTP [W${workerId}] Status [403]`, '#d55252');
                    } else {
                        logSolver(`Send OTP [W${workerId}] Status [${response.statusCode}]`, '#d55252', data);
                    }
                    return showStatus(data?.message || data?.error || "Invalid credentials", "error");
                }
                
                let waitMs = (__IVAC_RETRY__.seconds || 5) * 1000;
                if (response.statusCode === 403 || response.statusCode === 503) {
                    waitMs = 2500 + Math.floor(Math.random() * 501);
                } else if (response.statusCode === 429) {
                    waitMs = 20000; // 20s
                } else if ([500, 501, 502, 504, 520].includes(response.statusCode)) {
                    waitMs = 800 + Math.floor(Math.random() * 401);
                } else if ([400, 401].includes(response.statusCode)) {
                    waitMs = 1000;
                }
                
                if (response.statusCode === 403) {
                    logSolver(`${wTag} Send OTP Status [403] -> Retry in ${waitMs}ms`, '#d55252');
                } else {
                    logSolver(`${wTag} Send OTP Status [${response.statusCode}] -> Retry in ${waitMs}ms`, '#d55252', data);
                }

                if ([403, 503, 429].includes(response.statusCode)) {
                    return TaskManager.setTimeout(taskName, () => trySend(workerId, tokenToUse), waitMs);
                } else {
                    return TaskManager.setTimeout(taskName, () => trySend(workerId), waitMs);
                }
            }

            finishBtn("sendOtp", "Send OTP", "none");
            TaskManager.removeController(taskName, controller);
        } catch (err) {
            if (err.name !== "AbortError" && __IVAC_RETRY__?.enabled) {
                captchaToken = null;
                logSolver(`${wTag} Send OTP Cross Error: ${err.message}`, '#d55252');
                return TaskManager.setTimeout(taskName, () => trySend(workerId), 1000);
            }
            TaskManager.removeController(taskName, controller);
            finishBtn("sendOtp", "Send OTP", "none");
        }
    };

    const numWorkers = 1; //__IVAC_RETRY__?.mode ? 3 : 1;
    for (let i = 1; i <= numWorkers; i++) {
        trySend(i);
    }
}

async function verifyOtpAggressive(mobile, otp, __IVAC_RETRY__, isBatch = false) {
    // logSolver(`Verify OTP Setup Initialized...`, '#3b82f6');
    const requestId = authStorage?.state?.requestId;
    const accessToken = authStorage?.state?.token;

    if (!otp || !requestId) return showStatus("OTP or requestId missing", "error");
    if (!accessToken) return showStatus("Missing access token", "error");

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
                    logSolver(`OTP Verify Status [${res.statusCode}]`, '#d55252', data);
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
                
                logSolver(`OTP Verify Status [${res.statusCode}] -> Retry in ${waitMs}ms`, '#d55252', data);
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
        logSolver(`${wTag} ReserveSlot Started`, "#3b82f6");

        const onFail = (waitMs) => {
            if (__IVAC_RETRY__.logic === "batch" && activeCount > 1) {
                batchFailed++;
                if (batchFailed === activeCount && !successTriggered) {
                    const batchWait = 500 + Math.floor(Math.random() * 300);
                    logSolver(`[Batch] All ${activeCount} workers failed. Retrying in ${batchWait}ms...`, "#fbbf24");
                    TaskManager.setTimeout("reserveSlot", () => reserveSlotAggressive(__IVAC_RETRY__, true), batchWait);
                }
            } else {
                TaskManager.setTimeout("reserveSlot", () => worker(id, 0, null), waitMs);
            }
        };

        let recapToken;
        if (reuseToken) {
            recapToken = reuseToken;
        } else {
            let newToken = await solveAggressive();
            if (newToken) recapToken = encryptCaptchaToken(newToken);
            else { finishBtn("reserveSlot", "Reserve Slot", "none"); return showStatus("Auto captcha solve failed!", "error"); }
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
                const startTime = performance.now();
                let newToken = await solveAggressive();
                if (newToken) newToken = encryptCaptchaToken(newToken);
                else return showStatus("Auto captcha solve failed!", "error");

                const elapsed = (performance.now() - startTime) / 1000;
                const reqDelay = Math.max(wait - elapsed, 0);
                logSolver(`ReserveSlot Next Hit ${reqDelay.toFixed(2)}s`);
                TaskManager.removeController("reserveSlot", controller);
                return onFail(reqDelay * 1000);
            }

            if (res.statusCode !== 200) {
                 if (res.statusCode === 401) {
                     const bdTime = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Dhaka" }));
                     const isOver510PM = (bdTime.getHours() > 17) || (bdTime.getHours() === 17 && bdTime.getMinutes() >= 10);
                     
                     if (isOver510PM) {
                         TaskManager.stopAll();
                         logSolver(`ReserveSlot 401 Expired (After 5:10 PM). Auto Re-login...`, '#dc2626');
                         showStatus("Session Expired, auto re-login...", "error");
                         if (authStorage.state.phone && authStorage.state.password) {
                             sendOtp(authStorage.state.phone, authStorage.state.password, __IVAC_RETRY__);
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
                     if (res.statusCode === 403) {
                         logSolver(`ReserveSlot Status [403]`, '#d55252');
                     } else {
                         logSolver(`ReserveSlot Status [${res.statusCode}]`, '#d55252', data);
                     }
                     showStatus(data?.message || "Check Slot Failed", "error");
                     return;
                 }
                 
                 let waitMs = (__IVAC_RETRY__.seconds || 5) * 1000;
                 if (res.statusCode === 403 || res.statusCode === 503) waitMs = 2500 + Math.floor(Math.random() * 501); // 2.5s-3s
                 else if (res.statusCode === 429) waitMs = 20000; // 20s
                 else if ([500, 501, 502, 504, 520, 401].includes(res.statusCode)) waitMs = 800 + Math.floor(Math.random() * 401); // 800ms-1200ms
                 else if ([400].includes(res.statusCode)) waitMs = 1000;

                 if (res.statusCode === 403) {
                     logSolver(`${wTag} Slot Status [ 403 ]`, '#b057ff');
                 } else {
                     logSolver(`${wTag} Slot Status [ ${res.statusCode} ]`, '#b057ff', data);
                 }

                 TaskManager.removeController("reserveSlot", controller);
                 const startTime = performance.now();
                 
                 if ([403, 503, 429].includes(res.statusCode)) {
                     const reqDelay = Math.max(waitMs - (performance.now() - startTime), 0); 
                     logSolver(`${wTag} Next Hit ${(reqDelay/1000).toFixed(2)}s`);
                     return onFail(reqDelay);
                 }

                 let newToken = await solveAggressive();
                 if (newToken) newToken = encryptCaptchaToken(newToken);
                 else return showStatus("Auto captcha solve failed!", "error");

                 const elapsed = performance.now() - startTime;
                 const reqDelay = Math.max(waitMs - elapsed, 0); 
                 logSolver(`${wTag} Next Hit ${(reqDelay/1000).toFixed(2)}s`);
                 
                 return onFail(reqDelay);
            }

        } catch (e) {
            if (e.name === "AbortError") return;
            TaskManager.removeController("reserveSlot", controller);
            if (__IVAC_RETRY__?.enabled) {
                const wait = __IVAC_RETRY__.seconds || 10;
                logSolver(`ReserveSlot Status Cross/Error`, '#b057ff');
                const startTime = performance.now();
                let newToken = await solveAggressive();
                if (newToken) newToken = encryptCaptchaToken(newToken);
                const elapsed = (performance.now() - startTime) / 1000;
                const reqDelay = Math.max(wait - elapsed, 0);
                logSolver(`ReserveSlot Next Hit ${reqDelay.toFixed(2)}s`);
                return onFail(reqDelay * 1000);
            }
        }
    };

    // logSolver('Reserve Slot Started....');
    
    let numWorkersToStart = 1;
    if ((reserveSlotWorkerCount === 0 || isBatch) && __IVAC_RETRY__?.mode > 1) {
        numWorkersToStart = parseInt(__IVAC_RETRY__.mode, 10) || 3;
    }
    activeCount = numWorkersToStart;

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
        showStatus("Stopped All Backend Tasks", "error");
    }));
    
    socket.on("panel-login", (data, cb) => {
        if (data?.user === panelConfig.user && data?.pass === panelConfig.pass) {
            socket.authenticated = true;
            cb(true);
        } else {
            cb(false);
        }
    });
    
    socket.on("send-otp", secure((data) => { sendOtp(data.mobile, data.mbpassword, data.retrySettings, data.oldOtp); }));
    socket.on("verify-otp", secure((data) => { verifyOtpAggressive(data.mobile, data.otp, data.retrySettings); }));
    socket.on("reserve-slot", secure((data) => { reserveSlotAggressive(data.retrySettings); }));
    socket.on("pay-now", secure((data) => { payNow(data.retrySettings); }));
    
    socket.on("get-session-data", secure(() => {
        if (authStorage.state.isAuthenticated || authStorage.state.token) {
            socket.emit("receive-session-data", authStorage);
        }
    }));

    socket.on("get-otp", secure((data) => { pollOtpLoop(data.mobile, data.retrySettings, true); }));
    socket.on("reserve-otp", secure((data) => { reserveOtp(data.email,data.mobile, data.retrySettings); }));
    socket.on("warm-up-workers", secure(async (data) => {
        const workers = currentProxyState?.activeMode === "private" ? ((panelConfig?.additional_ips?.length || 0) + 1) :
                        currentProxyState?.activeMode === "random" ? ((currentProxyState?.proxies?.length || 0) + 1) : 1;
        
        const mobile = data?.mobile || authStorage.state.phone;
        const mbpassword = data?.mbpassword || authStorage.state.password;

        if (mobile && mbpassword) {
            sendOTPWarmUp(mobile, mbpassword, workers);
        } else {
            logSolver(`[WarmUp] Missing phone/password. Please perform a manual OTP hit first.`, "#d55252");
        }
    }));
    socket.on("check-slot", secure((data) => { checkSlot(data.retrySettings); }));
    socket.on("cap-settings", secure((data) => { CapInfo = data; logSolver("Server received new Captcha Settings.", "#10b981"); }));
    socket.on("proxy-state", secure((state) => { currentProxyState = state; workerNetworkClients.clear(); logSolver(`✔ Proxy Engine mapped to: ${state.activeMode}`, "#3b82f6"); }));
    
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
        preSolvedTokens = [];
        captchaToken = null;
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
        logSolver("> ==============================", "#10b981");
        logSolver("> SOFTWARE Restart successfully", "#10b981");
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
        logSolver(`[System] Batch Solving ${size} Captchas...`, "#3b82f6");
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
