// Global State
let isAuth = false;
let pollingInterval = null;
let logsInterval = null;
let incomingInterval = null;
let currentConfig = {};
let onlineDevices = [];
let monitoringExpiresTimer = null;

function apiFetch(url, options = {}) {
  const headers = new Headers(options.headers || {});
  const sessionId = localStorage.getItem("sms_session_id");
  const method = (options.method || "GET").toUpperCase();
  let finalUrl = url;
  if (sessionId) {
    headers.set("X-SMS-Session", sessionId);
    const joiner = finalUrl.includes("?") ? "&" : "?";
    finalUrl = `${finalUrl}${joiner}session_id=${encodeURIComponent(sessionId)}`;
  }
  return fetch(finalUrl, { ...options, headers });
}

// Init on Load
window.onload = function () {
  checkAuthStatus();
  // Set webhook URL dynamically
  const webhookUrl = `${window.location.origin}/webhook`;
  document.getElementById("webhookUrlDisplay").innerText = webhookUrl;
};

// Check if user is already authenticated
async function checkAuthStatus() {
  try {
    const res = await apiFetch("/api/status");
    if (!res.ok) throw new Error("Server communication error");
    const data = await res.json();
    
    if (data.authenticated) {
      showDashboard(data);
    } else {
      showLogin();
    }
  } catch (err) {
    showToast("Cannot connect to backend server", "error");
    showLogin();
  }
}

// Show/Hide Panels
function showDashboard(statusData) {
  isAuth = true;
  document.getElementById("loginContainer").classList.add("hidden");
  document.getElementById("loginCard").classList.add("hidden");
  document.getElementById("appContainer").classList.remove("hidden");
  
  // Set license key text
  updateKeyDisplay(statusData);
  
  // Initial Loads
  loadConfig();
  updateStatusUI(statusData);
  loadActivityLogs();
  loadAutoLogs();
  loadIncomingSms();
  refreshMonitoringUi(statusData);
  
  // Start Polling Loops
  if (pollingInterval) clearInterval(pollingInterval);
  pollingInterval = setInterval(pollStatus, 3000);
  
  // Start Logs Loading Loops
  if (logsInterval) clearInterval(logsInterval);
  logsInterval = setInterval(() => {
    loadActivityLogs();
    loadAutoLogs();
  }, 5000);

  if (incomingInterval) clearInterval(incomingInterval);
  incomingInterval = setInterval(loadIncomingSms, 5000);
}

function showLogin() {
  isAuth = false;
  document.getElementById("loginContainer").classList.remove("hidden");
  document.getElementById("loginCard").classList.remove("hidden");
  document.getElementById("appContainer").classList.add("hidden");
  
  // Stop Polling Loops
  if (pollingInterval) clearInterval(pollingInterval);
  if (logsInterval) clearInterval(logsInterval);
  if (incomingInterval) clearInterval(incomingInterval);
  if (monitoringExpiresTimer) clearInterval(monitoringExpiresTimer);
}

// UI Handlers
async function handleLogin(e) {
  e.preventDefault();
  const keyInput = document.getElementById("licenseKey");
  const linkInput = document.getElementById("profexLink");
  const key = keyInput.value.trim();
  const link = linkInput.value.trim();
  
  if (!key || !link) {
    showToast("Please fill in both the License Key and Profex URL", "error");
    return;
  }
  
  const submitBtn = document.getElementById("loginSubmitBtn");
  const spinner = document.getElementById("loginSpinner");
  
  submitBtn.disabled = true;
  spinner.style.display = "block";
  
  try {
    const res = await apiFetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ license_key: key, profex_link: link })
    });
    
    const data = await res.json();
    if (res.ok && data.success) {
      const sessionId = data.session_id || res.headers.get("X-SMS-Session");
      if (sessionId) {
        localStorage.setItem("sms_session_id", sessionId);
      }
      localStorage.setItem("sms_license_key", key);
      keyInput.value = "";
      linkInput.value = "";
      showToast("License key verified & Profex connection established!", "success");
      
      // Re-fetch status to get updated fields
      const statusRes = await apiFetch("/api/status");
      const statusData = await statusRes.json();
      showDashboard(statusData);
    } else {
      showToast(data.detail || "Authentication failed. Check your key and link.", "error");
    }
  } catch (err) {
    showToast("Network error. Verification failed.", "error");
  } finally {
    submitBtn.disabled = false;
    spinner.style.display = "none";
  }
}

// Dashboard-based quick link import
async function handleDashboardImportLink() {
  const linkInput = document.getElementById("profexLinkImportDashboard");
  const link = linkInput.value.trim();
  
  if (!link) {
    showToast("Please paste a valid Profex Netlify link first.", "error");
    return;
  }
  
  try {
    const res = await apiFetch("/api/config/import-link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ link: link })
    });
    
    const data = await res.json();
    if (res.ok && data.success) {
      showToast("Configuration imported and populated successfully!", "success");
      
      // Update form fields dynamically
      document.getElementById("firebaseUrl").value = data.firebase_url;
      document.getElementById("authKey").value = data.auth_key;
      linkInput.value = "";
      
      // Instant diagnostics update
      pollStatus();
    } else {
      showToast(data.detail || "Import failed. Verify link format.", "error");
    }
  } catch (err) {
    showToast("Network error during configuration import.", "error");
  }
}

async function handleLogout() {
  try {
    await apiFetch("/api/logout", { method: "POST" });
    localStorage.removeItem("sms_session_id");
    localStorage.removeItem("sms_license_key");
    showToast("Disconnected from stream.", "info");
    showLogin();
  } catch (err) {
    showLogin();
  }
}

// Config CRUD
async function loadConfig() {
  try {
    const res = await apiFetch("/api/config");
    if (!res.ok) return;
    const data = await res.json();
    currentConfig = data;
    
    document.getElementById("firebaseUrl").value = data.firebase_url || "";
    document.getElementById("authKey").value = data.auth_key || "";
    document.getElementById("selectedDevice").value = data.selected_device_id || "";
    document.getElementById("simSlot").value = data.selected_sim_slot || "1";
    document.getElementById("pollInterval").value = data.poll_interval || "2";
    
    // Save device ID temporarily to select it once devices load
    updateDeviceSelect(onlineDevices, data.selected_device_id);
  } catch (err) {
    console.error("Error loading config:", err);
  }
}

async function handleSaveConfig(e) {
  e.preventDefault();
  const url = document.getElementById("firebaseUrl").value.trim();
  const auth = document.getElementById("authKey").value.trim();
  const device = document.getElementById("selectedDevice").value;
  const sim = parseInt(document.getElementById("simSlot").value);
  const interval = parseInt(document.getElementById("pollInterval").value);
  
  const submitBtn = document.getElementById("saveConfigBtn");
  const spinner = document.getElementById("saveSpinner");
  
  submitBtn.disabled = true;
  spinner.style.display = "block";
  
  try {
    const res = await apiFetch("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        firebase_url: url,
        auth_key: auth,
        selected_device_id: device,
        selected_sim_slot: sim,
        poll_interval: interval
      })
    });
    
    if (res.ok) {
      showToast("Configuration saved successfully!", "success");
      currentConfig.selected_device_id = device;
      showMonitoringButtonState(false);
      pollStatus(); // Refresh status immediately
      loadIncomingSms();
    } else {
      const errData = await res.json();
      showToast(errData.detail || "Failed to save configuration.", "error");
    }
  } catch (err) {
    showToast("Network error. Failed to save.", "error");
  } finally {
    submitBtn.disabled = false;
    spinner.style.display = "none";
  }
}

async function handleStartMonitoring() {
  const btn = document.getElementById("monitorStartBtn");
  if (btn?.disabled) return;

  const originalLabel = btn?.querySelector("span")?.innerText || "Start Monitoring";
  if (btn) {
    btn.disabled = true;
    const label = btn.querySelector("span");
    if (label) label.innerText = "Starting Monitoring...";
  }

  try {
    const res = await apiFetch("/api/monitor/start", { method: "POST" });
    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.detail || "Unable to start monitoring");
    }
    showToast("Monitoring started for 10 minutes.", "success");
    refreshMonitoringUi(data);
    await pollStatus();
  } catch (err) {
    showToast(err.message || "Unable to start monitoring.", "error");
  } finally {
    if (btn) {
      btn.disabled = false;
      const label = btn.querySelector("span");
      if (label) label.innerText = originalLabel;
    }
  }
}

// Status Poller
async function pollStatus() {
  if (!isAuth) return;
  try {
    const res = await apiFetch("/api/status");
    if (!res.ok) return;
    const data = await res.json();
    
    if (!data.authenticated) {
      showLogin();
      return;
    }
    updateStatusUI(data);
  } catch (err) {
    console.warn("Status polling error:", err);
  }
}

function updateStatusUI(data) {
  // 1. Vercel Polling Status
  const vercelText = data.vercel_polling ? "Polling Active" : "Polling Inactive";
  const vercelStatus = document.getElementById("statusVercel");
  vercelStatus.innerText = vercelText;
  if (data.vercel_polling) {
    vercelStatus.className = "value text-glow-green";
    document.getElementById("vercelPollingStatus").className = "status-indicator live";
    document.getElementById("vercelPollingStatus").querySelector("span").innerText = "Stream Active";
  } else {
    vercelStatus.className = "value text-glow-red";
    document.getElementById("vercelPollingStatus").className = "status-indicator";
    document.getElementById("vercelPollingStatus").querySelector("span").innerText = "Stream Inactive";
  }
  
  document.getElementById("statusLastPoll").innerText = data.last_poll_time || "Never";
  
  // 2. Firebase Status
  const firebaseStatus = document.getElementById("statusFirebase");
  const firebaseChip = document.getElementById("firebaseOnlineChip");
  if (!data.firebase_configured) {
    firebaseStatus.innerText = "Not Configured";
    firebaseStatus.className = "value text-muted";
    if (firebaseChip) {
      firebaseChip.innerText = "OFFLINE";
      firebaseChip.className = "status-chip offline";
    }
  } else if (data.firebase_connected) {
    firebaseStatus.innerText = "Connected";
    firebaseStatus.className = "value text-glow-green";
    if (firebaseChip) {
      firebaseChip.innerText = "ONLINE";
      firebaseChip.className = "status-chip online";
    }
  } else {
    firebaseStatus.innerText = "Connection Failed";
    firebaseStatus.className = "value text-glow-red";
    if (firebaseChip) {
      firebaseChip.innerText = "OFFLINE";
      firebaseChip.className = "status-chip offline";
    }
  }
  
  // 3. Device status
  const deviceStatus = document.getElementById("statusDevice");
  const monitorActive = !!data.monitoring_active;
  if (!data.firebase_configured) {
    deviceStatus.innerText = "Waiting for Config";
    deviceStatus.className = "value text-muted";
  } else if (!monitorActive) {
    deviceStatus.innerText = "OFFLINE";
    deviceStatus.className = "value text-glow-red";
  } else if (data.selected_device_online) {
    deviceStatus.innerText = "ONLINE";
    deviceStatus.className = "value text-glow-green";
  } else {
    deviceStatus.innerText = "OFFLINE";
    deviceStatus.className = "value text-glow-red";
  }
  
  // 4. Update online devices list
  onlineDevices = data.online_devices || [];
  updateDeviceSelect(onlineDevices, currentConfig.selected_device_id);
  refreshMonitoringUi(data);
  updateKeyDisplay(data);
}

function updateKeyDisplay(data) {
  const keyEl = document.getElementById("activeKeyText");
  if (!keyEl) return;
  const key = String(data?.license_key || localStorage.getItem("sms_license_key") || "").trim();
  if (!key) {
    keyEl.innerText = "ACTIVE";
    return;
  }
  keyEl.innerText = key.length > 18 ? `${key.slice(0, 8)}...${key.slice(-4)}` : key;
  keyEl.title = key;
}

function refreshMonitoringUi(data) {
  const btn = document.getElementById("monitorStartBtn");
  const hint = document.getElementById("monitorHint");
  if (!btn || !hint) return;

  const active = !!data?.monitoring_active;
  showMonitoringButtonState(active);
  if (!active) {
    hint.innerText = "Monitoring is inactive until you start it.";
    if (monitoringExpiresTimer) {
      clearInterval(monitoringExpiresTimer);
      monitoringExpiresTimer = null;
    }
    return;
  }

  const expiresAt = data.monitoring_expires_at ? new Date(data.monitoring_expires_at) : null;
  if (expiresAt && !Number.isNaN(expiresAt.getTime())) {
    const remaining = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
    hint.innerText = `Monitoring active for ${formatDuration(remaining)} more.`;
    if (!monitoringExpiresTimer) {
      monitoringExpiresTimer = setInterval(() => {
        refreshMonitoringUi({ monitoring_active: true, monitoring_expires_at: data.monitoring_expires_at });
      }, 1000);
    }
  } else {
    hint.innerText = "Monitoring active.";
  }
}

function showMonitoringButtonState(active) {
  const btn = document.getElementById("monitorStartBtn");
  if (!btn) return;
  btn.disabled = active;
  btn.innerHTML = active ? "<span>Monitoring Active</span>" : "<span>Start Monitoring</span>";
}

function formatDuration(totalSeconds) {
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
}

function updateDeviceSelect(devices, selectedId) {
  const datalist = document.getElementById("onlineDevicesList");
  if (!datalist) return;
  
  datalist.innerHTML = "";
  
  devices.forEach(dev => {
    const opt = document.createElement("option");
    opt.value = dev;
    opt.innerText = dev;
    datalist.appendChild(opt);
  });
}

// Manual Bypass SMS Send
async function handleManualSend(e) {
  e.preventDefault();
  const to = document.getElementById("testRecipient").value.trim();
  const message = document.getElementById("testMessage").value.trim();
  
  if (!to || !message) return;
  
  const submitBtn = document.getElementById("sendTestBtn");
  const spinner = document.getElementById("testSpinner");
  
  submitBtn.disabled = true;
  spinner.style.display = "block";
  
  try {
    const res = await apiFetch("/api/send-test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to, message })
    });
    
    const data = await res.json();
    if (res.ok && data.success) {
      showToast("Manual SMS successfully queued via Firebase!", "success");
      document.getElementById("testRecipient").value = "";
      document.getElementById("testMessage").value = "";
      loadActivityLogs(); // Refresh logs to show this sent message
    } else {
      showToast(data.detail || "Manual send failed.", "error");
    }
  } catch (err) {
    showToast("Network error. Manual send failed.", "error");
  } finally {
    submitBtn.disabled = false;
    spinner.style.display = "none";
  }
}

// Logs Loader
async function loadActivityLogs() {
  if (!isAuth) return;
  try {
    const res = await apiFetch("/api/logs?kind=activity&limit=50");
    if (!res.ok) return;
    const logs = await res.json();
    renderLogs(logs, "logsTableBody");
  } catch (err) {
    console.error("Error loading logs:", err);
  }
}

async function loadAutoLogs() {
  if (!isAuth) return;
  try {
    const res = await apiFetch("/api/logs?kind=auto&limit=50");
    if (!res.ok) return;
    const logs = await res.json();
    renderLogs(logs, "autoLogsTableBody");
  } catch (err) {
    console.error("Error loading auto logs:", err);
  }
}

function renderLogs(logs, tbodyId) {
  const tbody = document.getElementById(tbodyId);
  tbody.innerHTML = "";
  
  if (logs.length === 0) {
    const emptyText = tbodyId === "autoLogsTableBody"
      ? "No auto-send transactions logged yet."
      : "No historical transactions logged yet.";
    tbody.innerHTML = `<tr><td colspan="6" class="text-center text-muted">${emptyText}</td></tr>`;
    return;
  }
  
  logs.forEach(log => {
    const tr = document.createElement("tr");
    
    // Format timestamp
    let timeStr = "N/A";
    if (log.timestamp) {
      try {
        const d = new Date(log.timestamp);
        timeStr = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      } catch (e) {}
    }
    
    // Message snippet
    const msg = log.message || "";
    const snippet = msg.length > 30 ? msg.substring(0, 30) + "..." : msg;
    const isAuto = log.status === "auto_injected" || log.status === "auto_inject_failed";
    const party = isAuto ? (log.from || "-") : (log.to || "-");
    
    // Status Badge
    const direction = log.direction === "incoming" ? "IN" : "OUT";
    const statusMeta = formatLogStatus(log.status, log);
    
    const speedText = log.elapsedSeconds ? `${log.elapsedSeconds.toFixed(2)}s` : "-";
    
    tr.innerHTML = `
      <td>${timeStr}</td>
      <td style="font-family: monospace; font-weight: 600;">${escapeHtml(String(party))}</td>
      <td title="${escapeHtml(msg)}">${escapeHtml(snippet)}</td>
      <td>${log.simSlot ? "SIM " + log.simSlot : "-"}</td>
      <td><span class="status-badge ${statusMeta.className}">${direction} ${statusMeta.label}</span></td>
      <td>${speedText}</td>
    `;
    tbody.appendChild(tr);
  });
}

function formatLogStatus(status, log = {}) {
  const normalized = String(status || "").trim().toLowerCase();
  if (normalized === "queued" || normalized === "ok" || normalized === "sent") {
    return { className: "badge-queued", label: "SMS sent successfully" };
  }
  if (normalized === "send_failed" || normalized === "failed" || normalized === "error") {
    return { className: "badge-error", label: "SMS failed" };
  }
  if (normalized === "auto_injected") {
    return { className: "badge-queued", label: "Auto injected" };
  }
  if (normalized === "auto_inject_failed") {
    return { className: "badge-error", label: "Auto inject failed" };
  }
  if (normalized === "injected") {
    return { className: "badge-queued", label: "Injected" };
  }
  if (normalized === "inject_failed") {
    return { className: "badge-error", label: "Inject failed" };
  }
  if (normalized === "received") {
    return { className: "badge-received", label: "Received" };
  }
  if (log.result && typeof log.result === "object" && (log.result.firebase_response || log.result.status === "ok")) {
    return { className: "badge-queued", label: "SMS sent successfully" };
  }
  return { className: "badge-queued", label: status ? String(status).replace(/_/g, " ") : "Queued" };
}

// Incoming SMS Loader
async function loadIncomingSms() {
  if (!isAuth) return;
  const tbody = document.getElementById("incomingTableBody");
  if (!tbody) return;

  try {
    const res = await apiFetch("/api/incoming-sms?limit=20");
    if (!res.ok) throw new Error("Incoming SMS fetch failed");
    const data = await res.json();
    renderIncomingSms(data.messages || [], data.configured);
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" class="text-center text-muted">Incoming SMS unavailable.</td></tr>`;
  }
}

function renderIncomingSms(messages, configured) {
  const tbody = document.getElementById("incomingTableBody");
  tbody.innerHTML = "";

  if (!configured) {
    tbody.innerHTML = `<tr><td colspan="7" class="text-center text-muted">Select a Firebase device to read incoming SMS.</td></tr>`;
    return;
  }

  if (messages.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="text-center text-muted">No incoming SMS found for selected device.</td></tr>`;
    return;
  }

  messages.forEach(msg => {
    const tr = document.createElement("tr");
    const timeStr = formatIncomingTime(msg);
    const body = msg.message || "";
    const snippet = body.length > 42 ? body.substring(0, 42) + "..." : body;

    tr.innerHTML = `
      <td>${escapeHtml(timeStr)}</td>
      <td style="font-family: monospace; font-weight: 600;">${escapeHtml(msg.from || "-")}</td>
      <td title="${escapeHtml(body)}">${escapeHtml(snippet)}</td>
      <td>${msg.simSlot && msg.simSlot !== "-" ? "SIM " + escapeHtml(String(msg.simSlot)) : "-"}</td>
      <td><span class="status-badge badge-received">RECEIVED</span></td>
      <td><button type="button" class="btn-copy-sms" data-message="${escapeHtml(body)}" onclick="copySmsMessage(this)">Copy</button></td>
      <td><button type="button" class="btn-send-inject" data-sender="${escapeHtml(msg.from || "")}" data-body="${escapeHtml(body)}" onclick="sendIncomingSms(this)">Send</button></td>
    `;
    tbody.appendChild(tr);
  });
}

async function copySmsMessage(button) {
  const message = button.dataset.message || "";
  if (!message) {
    showToast("No SMS text to copy.", "error");
    return;
  }

  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(message);
    } else {
      fallbackCopyText(message);
    }
    button.innerText = "Copied";
    button.classList.add("copied");
    showToast("SMS copied to clipboard.", "success");
    setTimeout(() => {
      button.innerText = "Copy";
      button.classList.remove("copied");
    }, 1600);
  } catch (err) {
    showToast("Copy failed. Try again.", "error");
  }
}

function fallbackCopyText(text) {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}

async function sendIncomingSms(button) {
  const sender = button.dataset.sender || "";
  const body = button.dataset.body || "";
  if (!sender || !body) {
    showToast("Sender or SMS body missing.", "error");
    return;
  }

  const originalText = button.innerText;
  button.disabled = true;
  button.innerText = "Sending";

  try {
    const res = await apiFetch("/api/inject-sms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sender, body })
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.detail || "Send failed");
    }
    button.innerText = "Sent";
    button.classList.add("sent");
    showToast(`Injected in ${data.elapsedSeconds || "-"}s`, "success");
  } catch (err) {
    button.disabled = false;
    button.innerText = originalText;
    showToast(err.message || "Send failed.", "error");
  }
}

function formatIncomingTime(msg) {
  if (msg.timestamp) {
    try {
      const d = new Date(msg.timestamp);
      if (!Number.isNaN(d.getTime())) {
        return d.toLocaleString([], {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          day: "2-digit",
          month: "short"
        });
      }
    } catch (e) {}
  }
  return msg.dateTime || "N/A";
}

// Toast Helpers
function showToast(message, type = "info") {
  const container = document.getElementById("toastContainer");
  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.innerText = message;
  
  container.appendChild(toast);
  
  // Animation delay
  setTimeout(() => toast.classList.add("show"), 10);
  
  // Autoclose
  setTimeout(() => {
    toast.classList.remove("show");
    setTimeout(() => toast.remove(), 400);
  }, 4000);
}

function escapeHtml(text) {
  if (!text) return "";
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
