const socket = io();
const $ = (id) => document.getElementById(id);

// --- GLOBAL STATE ---
let profiles = [];
let currentLogProfileId = null;
let currentSettingsMode = null; // 'dns' or 'cap'
let serverConfig = {};

// --- INITIALIZATION ---
window.onload = () => {
    initUI();
    checkLogin();
    initClock();
};

function checkLogin() {
    const isLogged = sessionStorage.getItem("panel_logged") === "true";
    const overlay = $("login-overlay");
    if (isLogged && overlay) overlay.style.display = "none";
}

function initUI() {
    // Login
    const loginBtn = $("login-btn");
    if (loginBtn) {
        loginBtn.onclick = () => {
            const user = $("panel-user")?.value;
            const pass = $("panel-pass")?.value;
            socket.emit("panel-login", { user, pass });
        };
    }

    // Add Profile
    const addProfileBtn = $("btn-add-profile");
    if (addProfileBtn) {
        addProfileBtn.onclick = () => openModal("modal-profile");
    }

    const saveProfileBtn = $("btn-save-profile");
    if (saveProfileBtn) {
        saveProfileBtn.onclick = () => {
            const pData = {
                taskName: $("p-name")?.value,
                email: $("p-email")?.value,
                mobile: $("p-mobile")?.value,
                password: $("p-pass")?.value
            };
            if (!pData.mobile || !pData.password) return alert("Mobile and Password required!");
            socket.emit("profile-add", pData);
            closeModal("modal-profile");
            ["p-name", "p-email", "p-mobile", "p-pass"].forEach(id => {
                const el = $(id);
                if (el) el.value = "";
            });
        };
    }

    // Logs
    const clearLogBtn = $("btn-clear-log");
    if (clearLogBtn) {
        clearLogBtn.onclick = () => {
            if (currentLogProfileId) {
                socket.emit("clear-profile-log", currentLogProfileId);
                const body = $("log-body");
                if (body) body.innerHTML = "";
            }
        };
    }

    // Global Auto Toggle
    const autoToggle = $("global-auto-toggle");
    if (autoToggle) {
        autoToggle.onclick = function() {
            if (this.innerText === "ENABLED") {
                this.innerText = "DISABLED";
                this.className = "badge badge-info";
            } else {
                this.innerText = "ENABLED";
                this.className = "badge badge-success";
            }
        };
    }

    // Settings Modals
    const dnsBtn = $("btn-dns-settings");
    if (dnsBtn) {
        dnsBtn.onclick = () => {
            currentSettingsMode = "dns";
            const title = $("settings-title");
            const body = $("settings-body");
            if (title) title.innerText = "DNS Engine Settings";
            if (body) {
                body.innerHTML = `
                    <div class="form-item">
                        <label>API Mode</label>
                        <select id="set-direct-api">
                            <option value="false" ${!serverConfig.directApi ? 'selected' : ''}>DNS Mapping (Bypass CF)</option>
                            <option value="true" ${serverConfig.directApi ? 'selected' : ''}>Direct Router API</option>
                        </select>
                    </div>
                    <div class="form-item">
                        <label>Custom DNS IP (ALB IP)</label>
                        <input type="text" id="set-dns-ip" value="${serverConfig.dnsIp || ''}" placeholder="e.g. 35.154.xxx.xxx">
                        <p style="font-size:10px; color:var(--text-secondary); margin-top:4px;">Leave blank to use default static IP from server.</p>
                    </div>
                `;
            }
            openModal("modal-settings");
        };
    }

    const capBtn = $("btn-cap-settings");
    if (capBtn) {
        capBtn.onclick = () => {
            currentSettingsMode = "cap";
            const cap = serverConfig.capInfo || {};
            const title = $("settings-title");
            const body = $("settings-body");
            if (title) title.innerText = "Captcha Solver Settings";
            if (body) {
                body.innerHTML = `
                    <div class="form-item">
                        <label>Solver Type</label>
                        <select id="set-cap-type">
                            <option value="capMonster" ${cap.type === 'capMonster' ? 'selected' : ''}>CapMonster Cloud</option>
                            <option value="capsolver" ${cap.type === 'capsolver' ? 'selected' : ''}>CapSolver.com</option>
                            <option value="twoCaptcha" ${cap.type === 'twoCaptcha' ? 'selected' : ''}>2Captcha.com</option>
                        </select>
                    </div>
                    <div class="form-item">
                        <label>API Key</label>
                        <input type="password" id="set-cap-key" value="${cap.key || ''}" placeholder="Paste your API key here">
                    </div>
                `;
            }
            openModal("modal-settings");
        };
    }

    const saveSettingsBtn = $("btn-save-settings");
    if (saveSettingsBtn) {
        saveSettingsBtn.onclick = () => {
            if (currentSettingsMode === "dns") {
                const payload = {
                    directApi: $("set-direct-api")?.value === "true",
                    dnsIp: $("set-dns-ip")?.value.trim() || null
                };
                socket.emit("update-direct-api", payload);
                serverConfig.directApi = payload.directApi;
                serverConfig.dnsIp = payload.dnsIp;
            } else if (currentSettingsMode === "cap") {
                const payload = {
                    type: $("set-cap-type")?.value,
                    key: $("set-cap-key")?.value.trim()
                };
                socket.emit("cap-settings", payload);
                serverConfig.capInfo = payload;
            }
            closeModal("modal-settings");
        };
    }

    const updateBtn = $("btn-update");
    if (updateBtn) {
        updateBtn.onclick = () => {
            if (confirm("Start system update via Git?")) {
                socket.emit("git-update");
            }
        };
    }

    const restartBtn = $("btn-restart");
    if (restartBtn) {
        restartBtn.onclick = () => {
            if (confirm("Perform a hard reset of all tasks and network clients?")) {
                socket.emit("hard-reset");
            }
        };
    }

    const startAllBtn = $("btn-start-all");
    if (startAllBtn) {
        startAllBtn.addEventListener("click", () => {
            if (!socket.connected) return alert("❌ Connection lost! Please refresh the page.");
            if (confirm("Start ALL profiles instantly?")) {
                const retrySettings = getGlobalSettings();
                socket.emit("all-profiles-start", { retrySettings });
                startAllBtn.style.opacity = "0.5";
                setTimeout(() => startAllBtn.style.opacity = "1", 500);
            }
        });
    }

    const resetAllBtn = $("btn-reset-all");
    if (resetAllBtn) {
        resetAllBtn.addEventListener("click", () => {
            if (!socket.connected) return alert("❌ Connection lost! Please refresh the page.");
            if (confirm("Reset ALL profiles? This clears all states and logs.")) {
                socket.emit("all-profiles-reset");
                resetAllBtn.style.opacity = "0.5";
                setTimeout(() => resetAllBtn.style.opacity = "1", 500);
            }
        });
    }

    const stopAllGlobalBtn = $("btn-stop-all-global");
    if (stopAllGlobalBtn) {
        stopAllGlobalBtn.addEventListener("click", () => {
            if (!socket.connected) return alert("❌ Connection lost! Please refresh the page.");
            if (confirm("Stop ALL active tasks?")) {
                socket.emit("all-profiles-stop");
                stopAllGlobalBtn.style.opacity = "0.5";
                setTimeout(() => stopAllGlobalBtn.style.opacity = "1", 500);
            }
        });
    }
}

function initClock() {
    setInterval(() => {
        const bdTime = new Date().toLocaleTimeString("en-US", { timeZone: "Asia/Dhaka", hour12: true });
        const clock = $("bd-clock");
        if (clock) clock.innerText = bdTime;
    }, 1000);
}

// --- MODAL HELPERS ---
window.openModal = (id) => { 
    const el = $(id);
    if (el) el.classList.add("active"); 
};
window.closeModal = (id) => { 
    const el = $(id);
    if (el) el.classList.remove("active");
    if (id === 'modal-logs') currentLogProfileId = null;
};

// --- PROFILE ACTIONS ---
function renderProfiles(data) {
    profiles = data;
    const list = $("task-list");
    if (!list) return;
    list.innerHTML = "";
    
    profiles.forEach(p => {
        const row = document.createElement("tr");
        row.id = `row-${p.id}`;
        
        // Step Status Visualization
        const steps = p.steps || { signin: 'idle', verify: 'idle', reserve: 'idle', pay: 'idle' };
        const getCls = (s) => s === 'done' ? 'done' : (s === 'active' ? 'active' : (s === 'error' ? 'error' : ''));
        const getIcon = (s) => s === 'done' ? '✓' : (s === 'active' ? '➜' : (s === 'error' ? '✖' : ''));

        row.innerHTML = `
            <td>
                <div style="display:flex; align-items:center; gap:6px;">
                    <button class="btn btn-danger" style="padding:2px 4px; font-size:10px; border-radius: 4px;" onclick="handleRemove('${p.id}')" title="Delete Profile">🗑️</button>
                    <div>
                        <div style="font-weight:700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 80px;">${p.taskName || 'Unnamed'}</div>
                        <div style="font-size:10px; color:var(--text-secondary);">ID: ${p.id}</div>
                    </div>
                </div>
            </td>
            <td>
                <div style="font-size:11px;">${p.email || 'No Email'}</div>
                <div style="font-weight:600; color:var(--accent-blue);">${p.mobile}</div>
            </td>
            <td>
                <div class="otp-input-group">
                    <input type="text" id="otp-${p.id}" placeholder="OTP" maxlength="6" style="width: 70px;">
                    <button class="btn btn-ghost" style="padding:4px 6px;" onclick="handleGetOtp('${p.id}')" title="Get SMS">📩</button>
                </div>
            </td>
            <td>
                <div id="session-${p.id}" style="font-family: 'JetBrains Mono', monospace; font-size: 10px; font-weight: 700; color: var(--accent-blue); border: 1px solid rgba(59, 130, 246, 0.3); background: rgba(59, 130, 246, 0.1); padding: 2px 6px; border-radius: 4px; display: inline-block; min-width: 60px; text-align: center;">${formatCountdown(p.verifiedAt)}</div>
            </td>
            <td>
                <div class="status-steps" id="steps-${p.id}">
                    <div class="step-item ${getCls(steps.signin)}" title="Signin/OTP">OTP ${getIcon(steps.signin)}</div>
                    <div class="step-sep">></div>
                    <div class="step-item ${getCls(steps.verify)}" title="Verify">VERIFY ${getIcon(steps.verify)}</div>
                    <div class="step-sep">></div>
                    <div class="step-item ${getCls(steps.reserve)}" title="Reserve">RESERVE ${getIcon(steps.reserve)}</div>
                    <div class="step-sep">></div>
                    <div class="step-item ${getCls(steps.pay)}" title="Payment">PAY ${getIcon(steps.pay)}</div>
                </div>
            </td>
            <td>
                <div class="status-msg" id="status-${p.id}">${p.status?.msg || 'Ready'}</div>
                <div style="font-size:10px; color:var(--text-secondary); margin-top:4px;" id="time-${p.id}">${p.status?.time || '-'}</div>
            </td>
            <td id="result-${p.id}">-</td>
            <td>
                <div style="display:flex; flex-wrap:wrap; gap:4px;">
                    <button class="btn btn-primary" style="padding:4px 6px; font-size:9px;" onclick="handleAction('${p.id}', 'send-otp')">SendOtp</button>
                    <button class="btn btn-warning" style="padding:4px 6px; font-size:9px;" onclick="handleAction('${p.id}', 'verify')">Verify</button>
                    <button class="btn btn-purple" style="padding:4px 6px; font-size:9px;" onclick="handleAction('${p.id}', 'reserve')">Reserve</button>
                    <button class="btn btn-success" style="padding:4px 6px; font-size:9px;" onclick="handleAction('${p.id}', 'paynow')">PayNow</button>
                    <button class="btn btn-info" style="padding:4px 6px; font-size:9px;" onclick="handleAction('${p.id}', 'reset')">Reset</button>
                    <button class="btn btn-danger" style="padding:4px 6px; font-size:9px;" onclick="handleStop('${p.id}')">Stop</button>
                    <button class="btn btn-ghost" style="padding:4px 6px; font-size:9px;" onclick="showLogs('${p.id}')">📜</button>
                </div>
            </td>
        `;
        list.appendChild(row);
    });
}

window.handleAction = (id, type) => {
    const retrySettings = getGlobalSettings();
    if (type === 'verify') {
        const otp = $(`otp-${id}`).value;
        if (!otp) return alert("Enter OTP first!");
        socket.emit("profile-verify-otp", { profileId: id, otp, retrySettings });
    } else if (type === 'send-otp') {
        socket.emit("profile-start", { profileId: id, retrySettings });
    } else if (type === 'reserve') {
        socket.emit("profile-reserve", { profileId: id, retrySettings });
    } else if (type === 'paynow') {
        socket.emit("profile-paynow", { profileId: id, retrySettings });
    } else if (type === 'reset') {
        if (confirm("Reset all session variables for this profile?")) {
            socket.emit("profile-reset", id);
        }
    }
};

function handleStop(id) {
    socket.emit("profile-stop", id);
}

function formatCountdown(verifiedAt) {
    if (!verifiedAt) return "-";
    const now = Date.now();
    const expiry = verifiedAt + (15 * 60 * 1000); // 15 Minutes
    const diff = expiry - now;
    if (diff <= 0) return "EXPIRED";
    const mins = Math.floor(diff / 60000);
    const secs = Math.floor((diff % 60000) / 1000);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

// Global Session Timer Update
setInterval(() => {
    profiles.forEach(p => {
        const el = $(`session-${p.id}`);
        if (el && p.verifiedAt) {
            const timeStr = formatCountdown(p.verifiedAt);
            el.innerText = timeStr;
            el.style.color = timeStr === "EXPIRED" ? "var(--accent-red)" : "var(--accent-blue)";
        }
    });
}, 1000);
window.handleRemove = (id) => {
    if (confirm("⚠️ CAUTION: Are you sure you want to PERMANENTLY DELETE this profile and all its logs? This cannot be undone.")) {
        socket.emit("profile-remove", id);
    }
};
window.showLogs = (id) => {
    currentLogProfileId = id;
    const profile = profiles.find(p => p.id == id);
    const title = $("log-title");
    const body = $("log-body");
    if (title) title.innerText = `Logs: ${profile ? profile.taskName : id}`;
    if (body) body.innerHTML = '<div style="color:var(--text-secondary);">Loading logs...</div>';
    openModal("modal-logs");
    socket.emit("get-profile-log", id);
};

// --- GLOBAL SETTINGS HELPERS ---
function getGlobalSettings() {
    return {
        enabled: $("global-auto-toggle")?.innerText === "ENABLED",
        seconds: parseInt($("global-retry-sec")?.value || 20),
        mode: parseInt($("global-retry-mode")?.value || 5),
        network: $("global-proxy-select")?.value || 'native',
        logic: $("global-retry-logic")?.value || 'batch',
        hitTime: $("global-hit-time")?.value || '17:00:00'
    };
}

// --- SOCKET LISTENERS ---
socket.on("initial-config", (data) => { serverConfig = data; });

socket.on("login-success", (data) => {
    sessionStorage.setItem("panel_logged", "true");
    if (data?.token) sessionStorage.setItem("panel_token", data.token);
    const overlay = $("login-overlay");
    if (overlay) overlay.style.display = "none";
});

socket.on("connect", () => {
    const token = sessionStorage.getItem("panel_token");
    if (token) {
        socket.emit("panel-session-login", { token }, (success) => {
            if (success) {
                const overlay = $("login-overlay");
                if (overlay) overlay.style.display = "none";
                sessionStorage.setItem("panel_logged", "true");
            } else {
                sessionStorage.removeItem("panel_token");
                sessionStorage.removeItem("panel_logged");
                const overlay = $("login-overlay");
                if (overlay) overlay.style.display = "flex";
            }
        });
    }
});

socket.on("login-error", (msg) => {
    const err = $("login-error");
    if (err) {
        err.innerText = msg;
        err.style.display = "block";
    }
});

socket.on("all-profiles", renderProfiles);
socket.on("profile-added", (p) => {
    profiles.push(p);
    renderProfiles(profiles);
});
socket.on("profile-removed", (id) => {
    profiles = profiles.filter(p => p.id != id);
    renderProfiles(profiles);
});

socket.on("profile-status", (data) => {
    const { profileId, msg, type, time, steps, verifiedAt } = data;
    const statusEl = $(`status-${profileId}`);
    const timeEl = $(`time-${profileId}`);
    const stepsEl = $(`steps-${profileId}`);
    const sessionEl = $(`session-${profileId}`);

    // Update global array for the timer
    const pIdx = profiles.findIndex(p => p.id == profileId);
    if (pIdx !== -1) {
        profiles[pIdx].verifiedAt = verifiedAt;
        if (steps) profiles[pIdx].steps = steps;
    }
    
    if (statusEl) {
        statusEl.innerText = msg;
        statusEl.style.color = type === "success" ? "var(--accent-green)" : (type === "error" ? "var(--accent-red)" : "var(--text-secondary)");
    }
    if (timeEl) timeEl.innerText = time || new Date().toLocaleTimeString();
    
    if (sessionEl) {
        if (verifiedAt) {
            sessionEl.innerText = formatCountdown(verifiedAt);
        } else {
            sessionEl.innerText = "-";
        }
    }

    const resultEl = $(`result-${profileId}`);
    if (resultEl && !verifiedAt) {
        resultEl.innerText = "-";
    }

    if (stepsEl && steps) {
        const getCls = (s) => s === 'done' ? 'done' : (s === 'active' ? 'active' : (s === 'error' ? 'error' : ''));
        const getIcon = (s) => s === 'done' ? '✓' : (s === 'active' ? '➜' : (s === 'error' ? '✖' : ''));
        stepsEl.innerHTML = `
            <div class="step-item ${getCls(steps.signin)}" title="Signin/OTP">OTP ${getIcon(steps.signin)}</div>
            <div class="step-sep">></div>
            <div class="step-item ${getCls(steps.verify)}" title="Verify">VERIFY ${getIcon(steps.verify)}</div>
            <div class="step-sep">></div>
            <div class="step-item ${getCls(steps.reserve)}" title="Reserve">RESERVE ${getIcon(steps.reserve)}</div>
            <div class="step-sep">></div>
            <div class="step-item ${getCls(steps.pay)}" title="Payment">PAY ${getIcon(steps.pay)}</div>
        `;
    }
});

socket.on("profile-log-clear", (id) => {
    if (currentLogProfileId == id) {
        const body = $("log-body");
        if (body) body.innerHTML = "";
    }
});

socket.on("profile-log", (data) => {
    if (currentLogProfileId == data.profileId) {
        const body = $("log-body");
        if (body) {
            const div = document.createElement("div");
            div.style.color = data.color || "#10b981";
            div.style.marginBottom = "2px";
            div.innerText = `[${data.time}] ${data.msg}`;
            body.appendChild(div);
            body.scrollTop = body.scrollHeight;
        }
    }
});

socket.on("profile-log-clear", (profileId) => {
    if (currentLogProfileId == profileId) {
        const body = $("log-body");
        if (body) body.innerHTML = "";
    }
});

socket.on("profile-log-data", (data) => {
    if (currentLogProfileId == data.profileId) {
        const body = $("log-body");
        if (body) {
            body.innerText = data.content || "No logs available.";
            body.scrollTop = body.scrollHeight;
        }
    }
});

socket.on("solver-log", (data) => {
    const console = $("system-logs");
    if (console) {
        const div = document.createElement("div");
        div.style.color = data.color || "#94a3b8";
        div.style.marginBottom = "2px";
        div.innerText = `[${data.time || new Date().toLocaleTimeString()}] ${data.msg}`;
        console.appendChild(div);
        console.scrollTop = console.scrollHeight;
    }
});

socket.on("payment-link", (data) => {
    const resultEl = $(`result-${data.profileId}`);
    if (resultEl) {
        resultEl.innerHTML = `<a href="${data.url}" target="_blank" class="btn btn-success" style="padding:4px 8px; font-size:10px;">PAY NOW</a>`;
    }
});
let lastSuccessProfileId = null;
socket.on("show-reservation-success-popup", (data) => {
    lastSuccessProfileId = data.profileId;
    const nameEl = $("success-task-name");
    if (nameEl) nameEl.innerText = data.taskName;
    openModal("modal-success");
});

const successPayBtn = $("btn-success-pay");
if (successPayBtn) {
    successPayBtn.onclick = () => {
        if (lastSuccessProfileId) {
            const p = profiles.find(x => x.id == lastSuccessProfileId);
            if (p && p.paymentUrl) {
                window.open(p.paymentUrl, "_blank");
                closeModal("modal-success");
            } else {
                alert("Payment link still generating... please wait a second.");
            }
        }
    };
}
