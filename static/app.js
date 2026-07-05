// Global State
let isAuth = false;
let pollingInterval = null;
let logsInterval = null;
let incomingInterval = null;
let currentConfig = {};
let onlineDevices = [];

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
  document.getElementById("activeKeyText").innerText = "ACTIVE";
  
  // Initial Loads
  loadConfig();
  updateStatusUI(statusData);
  loadLogs();
  loadIncomingSms();
  
  // Start Polling Loops
  if (pollingInterval) clearInterval(pollingInterval);
  pollingInterval = setInterval(pollStatus, 3000);
  
  // Start Logs Loading Loops
  if (logsInterval) clearInterval(logsInterval);
  logsInterval = setInterval(loadLogs, 5000);

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
  if (!data.firebase_configured) {
    firebaseStatus.innerText = "Not Configured";
    firebaseStatus.className = "value text-muted";
  } else if (data.firebase_connected) {
    firebaseStatus.innerText = "Connected";
    firebaseStatus.className = "value text-glow-green";
  } else {
    firebaseStatus.innerText = "Connection Failed";
    firebaseStatus.className = "value text-glow-red";
  }
  
  // 3. Device status
  const deviceStatus = document.getElementById("statusDevice");
  if (!data.firebase_configured) {
    deviceStatus.innerText = "Waiting for Config";
    deviceStatus.className = "value text-muted";
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
      loadLogs(); // Refresh logs to show this sent message
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
async function loadLogs() {
  if (!isAuth) return;
  try {
    const res = await apiFetch("/api/logs");
    if (!res.ok) return;
    const logs = await res.json();
    renderLogs(logs);
  } catch (err) {
    console.error("Error loading logs:", err);
  }
}

function renderLogs(logs) {
  const tbody = document.getElementById("logsTableBody");
  tbody.innerHTML = "";
  
  if (logs.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="text-center text-muted">No historical transactions logged yet.</td></tr>`;
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
    
    // Status Badge
    let badgeClass = "badge-queued";
    const direction = log.direction === "incoming" ? "IN" : "OUT";
    let statusText = log.status || "queued";
    if (statusText !== "queued" && statusText !== "ok") {
      badgeClass = "badge-error";
    }
    
    const speedText = log.elapsedSeconds ? `${log.elapsedSeconds.toFixed(2)}s` : "-";
    
    tr.innerHTML = `
      <td>${timeStr}</td>
      <td style="font-family: monospace; font-weight: 600;">${log.to || "-"}</td>
      <td title="${escapeHtml(msg)}">${escapeHtml(snippet)}</td>
      <td>${log.simSlot ? "SIM " + log.simSlot : "-"}</td>
      <td><span class="status-badge ${badgeClass}">${direction} ${statusText}</span></td>
      <td>${speedText}</td>
    `;
    tbody.appendChild(tr);
  });
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
