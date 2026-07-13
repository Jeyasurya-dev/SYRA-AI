/* =====================================================================
   SYRA AI — JavaScript Core Application Engine
   Application features ONLY: AI Chat, Sidebar, Theme, Weather, History,
   Uploads, Image Generation, Search, UI interactions, Navigation,
   Settings, Workspace, Animations.

   Authentication (login/register/OTP/Google/logout/session) lives
   exclusively in auth.js. This file never touches those concerns —
   it only *reads* the cached user profile (written by auth.js) when a
   feature needs to tag a request with the current user's identity.
   ===================================================================== */
const API_BASE = "http://127.0.0.1:5000";

// Local storage key auth.js uses to cache the logged-in user's profile.
// Declared here (read-only) so app features can identify the current
// user without owning any authentication logic themselves.
const CACHED_USER_KEY = "syra_user";

// =====================================================================
// APP-LEVEL API CLIENT (CSRF + fetch helpers for application features:
// chat streaming, uploads, vision, voice, image/website/project gen)
// =====================================================================
let csrfToken = null;

// Fetches (and caches) the CSRF token minted by the backend for this
// session. Called once on load and safe to re-call any time a request
// comes back without a valid token.
async function fetchCsrfToken() {
  try {
    const res = await fetch(`${API_BASE}/api/csrf-token`, { credentials: "include" });
    const data = await res.json();
    if (data && data.csrf_token) csrfToken = data.csrf_token;
  } catch (e) {
    console.error("Failed to fetch CSRF token:", e);
  }
  return csrfToken;
}

// Thin wrapper around fetch() for /api calls: always sends cookies, always
// attaches the CSRF header on state-changing requests, and JSON-encodes a
// plain object body automatically.
async function apiFetch(url, { method = "GET", body = null } = {}) {
  const headers = { "Content-Type": "application/json" };
  const unsafe = ["POST", "PUT", "PATCH", "DELETE"].includes(method.toUpperCase());
  if (unsafe) {
    if (!csrfToken) await fetchCsrfToken();
    headers["X-CSRF-Token"] = csrfToken || "";
  }
  const res = await fetch(url, {
    method,
    headers,
    credentials: "include",
    body: body ? JSON.stringify(body) : undefined
  });
  let data = {};
  try { data = await res.json(); } catch (e) { /* non-JSON response */ }
  return { ok: res.ok, status: res.status, data };
}

// =====================================================================
// STATE ENGINE
// =====================================================================
// `chats` stays as a lightweight in-memory HTML render cache keyed by
// conversation id (not array index) so re-visiting a conversation during
// the same page load doesn't need a round-trip. The source of truth for
// what conversations exist and what's inside them is now the backend's
// SQLite-backed /api/conversations endpoints, not localStorage.
let chats = {};
let currentConversationId = null;
let conversationsMeta = []; // last list fetched from /api/conversations
let isProcessing = false;
let abortController = null;

let isWebSearchEnabled = false;
let isDeepThinkEnabled = false;
let activeModel = "default";
let activeChatMode = "general"; // general, code, agri, website, project
let pendingAttachment = null; // { file, previewUrl, category } — staged, not yet uploaded

// Initial state load
document.addEventListener("DOMContentLoaded", () => {
  initApp();
  fetchCsrfToken();
  getLiveWeather();
  initTextareaResizer();
  initAttachmentInput();
  injectVoiceMenuEntry();
  loadServerSettings();
  autoLoadLastChat();
});

function genConvId() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID().slice(0, 12);
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function currentSessionIdParam() {
  const cachedProfile = JSON.parse(localStorage.getItem(CACHED_USER_KEY) || "null");
  return (cachedProfile && cachedProfile.email) || "anon";
}

// Auto-loads the most recently updated conversation (pinned chats first)
// on page load. Falls back to starting a fresh session if the person has
// no saved chats yet.
async function autoLoadLastChat() {
  try {
    const { data } = await apiFetch(`${API_BASE}/api/conversations?session_id=${encodeURIComponent(currentSessionIdParam())}`);
    conversationsMeta = (data && data.conversations) || [];
  } catch (e) {
    conversationsMeta = [];
  }

  renderHistoryList(conversationsMeta);

  if (conversationsMeta.length > 0) {
    await openConversation(conversationsMeta[0].id);
  } else {
    currentConversationId = genConvId();
    createNewSession("Welcome to SYRA Workspace");
  }
}

// =====================================================================
// INITIALIZATION & VIEWPORT CONTROLS
// =====================================================================
function initApp() {
  const yearEl = document.getElementById("year");
  if (yearEl) yearEl.textContent = new Date().getFullYear();

  const savedTheme = localStorage.getItem("syra_theme") || "dark";
  document.documentElement.setAttribute("data-theme", savedTheme);

  // Session state (logged in vs guest) is resolved entirely by auth.js's
  // own checkSession(), which runs on its own DOMContentLoaded listener
  // and updates the shared profile UI elements directly.
}

// Section Switching
function openChat() {
  document.getElementById("homeSection").style.display = "none";
  document.getElementById("chatSection").classList.add("active");
  toggleChatMenu(true);
}

function backToHome() {
  document.getElementById("chatSection").classList.remove("active");
  document.getElementById("homeSection").style.display = "block";
}

function toggleHomeMenu() {
  document.getElementById("sidePanel").classList.toggle("open");
  document.getElementById("menuOverlay").classList.toggle("show");
}

function toggleChatMenu(forceClose = false) {
  const menu = document.getElementById("sideMenu");
  if (forceClose) {
    menu.classList.remove("open");
  } else {
    menu.classList.toggle("open");
  }
}

// Profile badge at the bottom of the workspace side menu — takes the
// user to Settings, where they can manage their account or log out.
function handleMenuClick() {
  toggleChatMenu(true);
  openSettings();
}

// =====================================================================
// FILE ATTACHMENTS & PLUS MENU
// =====================================================================
function togglePopup() {
  const menu = document.getElementById("popupMenu");
  menu.style.display = (menu.style.display === "block") ? "none" : "block";
}

function triggerFileInput(type) {
  const input = document.getElementById("mediaFileInput");
  if (type === "camera") {
    input.setAttribute("capture", "environment");
    input.setAttribute("accept", "image/*");
  } else if (type === "gallery") {
    input.removeAttribute("capture");
    input.setAttribute("accept", "image/*,video/*");
  } else {
    input.removeAttribute("capture");
    input.setAttribute("accept", ".txt,.pdf,.docx,.xlsx,.csv,.zip,.json,.xml,.md,.png,.jpg,.jpeg,.gif,.webp,.mp3,.wav,.ogg");
  }
  input.click();
  togglePopup();
}

// ChatGPT-style attach flow: selecting/dropping/pasting a file only STAGES
// it (thumbnail + name + size + remove/replace) in the input area. Nothing
// is uploaded to the server until the user actually presses Send.
function handleFileSelect() {
  const fileInput = document.getElementById("mediaFileInput");
  const file = fileInput.files[0];
  if (!file) return;
  stageAttachment(file);
  // Reset input so the same file can be re-selected later
  fileInput.value = "";
}

function stageAttachment(file) {
  if (!file) return;
  if (pendingAttachment && pendingAttachment.previewUrl) {
    URL.revokeObjectURL(pendingAttachment.previewUrl);
  }
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  const imageExts = ["png", "jpg", "jpeg", "gif", "webp"];
  const category = imageExts.includes(ext) ? "image" : "document";
  const previewUrl = category === "image" ? URL.createObjectURL(file) : null;
  pendingAttachment = { file, previewUrl, category };
  renderAttachmentPreview();
}

function clearAttachment() {
  if (pendingAttachment && pendingAttachment.previewUrl) {
    URL.revokeObjectURL(pendingAttachment.previewUrl);
  }
  pendingAttachment = null;
  renderAttachmentPreview();
}

function renderAttachmentPreview() {
  let bar = document.getElementById("attachmentPreviewBar");
  const inputArea = document.getElementById("messageInput");

  if (!pendingAttachment) {
    if (bar) bar.style.display = "none";
    return;
  }

  if (!bar) {
    bar = document.createElement("div");
    bar.id = "attachmentPreviewBar";
    bar.style.cssText = "display:flex;align-items:center;gap:10px;padding:8px 10px;margin:6px 0;background:rgba(255,255,255,0.06);border-radius:12px;";
    if (inputArea && inputArea.parentNode) {
      inputArea.parentNode.insertBefore(bar, inputArea);
    } else {
      document.body.appendChild(bar);
    }
  }

  const { file, previewUrl, category } = pendingAttachment;
  const sizeKb = Math.round(file.size / 1024);
  const thumb = category === "image"
    ? `<img src="${previewUrl}" alt="preview" style="width:44px;height:44px;object-fit:cover;border-radius:8px;">`
    : `<div style="width:44px;height:44px;display:flex;align-items:center;justify-content:center;background:rgba(255,255,255,0.1);border-radius:8px;font-size:18px;">📄</div>`;

  bar.style.display = "flex";
  bar.innerHTML = `
    ${thumb}
    <div style="flex:1;min-width:0;">
      <div style="font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(file.name)}</div>
      <div style="font-size:11px;opacity:0.65;">${sizeKb} KB</div>
    </div>
    <button type="button" title="Replace" style="background:none;border:none;color:inherit;cursor:pointer;font-size:15px;">🔁</button>
    <button type="button" title="Remove" style="background:none;border:none;color:inherit;cursor:pointer;font-size:15px;">✖</button>
  `;
  const [replaceBtn, removeBtn] = bar.querySelectorAll("button");
  replaceBtn.onclick = () => triggerFileInput("file");
  removeBtn.onclick = () => clearAttachment();
}

// Drag & drop and paste (Ctrl+V) support — stages the file the same way
// as picking it from the file dialog.
function initAttachmentInput() {
  const dropZone = document.getElementById("chatSection") || document.body;

  ["dragover", "dragenter"].forEach(evt => {
    dropZone.addEventListener(evt, e => {
      e.preventDefault();
      dropZone.classList.add("drag-active");
    });
  });
  ["dragleave", "drop"].forEach(evt => {
    dropZone.addEventListener(evt, e => {
      e.preventDefault();
      dropZone.classList.remove("drag-active");
    });
  });
  dropZone.addEventListener("drop", e => {
    e.preventDefault();
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) stageAttachment(file);
  });

  document.addEventListener("paste", e => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (const item of items) {
      if (item.kind === "file") {
        const file = item.getAsFile();
        if (file) {
          stageAttachment(file);
          e.preventDefault();
          break;
        }
      }
    }
  });
}

// XHR wrapper so uploads report real progress (fetch() cannot report
// upload progress, which is why this isn't just another fetch() call).
async function uploadWithProgress(url, formData, onProgress) {
  if (!csrfToken) await fetchCsrfToken();
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.withCredentials = true;
    xhr.setRequestHeader("X-CSRF-Token", csrfToken || "");
    xhr.upload.onprogress = e => {
      if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      try {
        resolve(JSON.parse(xhr.responseText));
      } catch (e) {
        reject(new Error("Invalid server response"));
      }
    };
    xhr.onerror = () => reject(new Error("Network error"));
    xhr.ontimeout = () => reject(new Error("Upload timed out"));
    xhr.send(formData);
  });
}

async function uploadDatasetFile(file, loaderBox) {
  loaderBox.innerHTML = `<span class="thinking-span">📤 Uploading ${escapeHtml(file.name)}... 0%</span>`;
  const formData = new FormData();
  formData.append("file", file);
  const data = await uploadWithProgress(`${API_BASE}/api/upload_dataset`, formData, pct => {
    loaderBox.innerHTML = `<span class="thinking-span">📤 Uploading ${escapeHtml(file.name)}... ${pct}%</span>`;
  });
  if (!(data.ok || data.success)) {
    throw new Error(data.error || "Upload failed");
  }
  return data;
}

async function uploadAndAnalyzeImage(file, question, loaderBox) {
  loaderBox.innerHTML = `<span class="thinking-span">📤 Uploading image... 0%</span>`;
  const formData = new FormData();
  formData.append("image", file);
  formData.append("question", question || "Describe this image in detail.");
  const data = await uploadWithProgress(`${API_BASE}/api/vision`, formData, pct => {
    loaderBox.innerHTML = `<span class="thinking-span">👁️ Analyzing image... ${pct}%</span>`;
  });
  if (data.ok && data.message) {
    loaderBox.innerHTML = formatMarkdown(data.message);
    attachSpeechControls(loaderBox, data.message);
    if (isVoiceResponseEnabled()) speakText(data.message, { auto: true });
    attachActionBarOnly(loaderBox, data.message);
    return data.message;
  }
  loaderBox.innerHTML = `⚠️ Vision analysis failed: ${escapeHtml(data.error || "Unknown error")}`;
  return null;
}

function triggerMenuAction(action) {
  togglePopup();
  if (action === "image") {
    addMessageToUI("🎨 Let's generate some artwork! Enter a descriptive text prompt for the image.", "bot");
  } else if (action === "website") {
    activeChatMode = "website";
    addMessageToUI("💻 Let's build a stunning web application! Describe your app structure, sections, and interactions.", "bot");
  } else if (action === "project") {
    activeChatMode = "project";
    addMessageToUI("📂 Let's build a software system! Describe your architecture, features, and desired code structure.", "bot");
  }
}

function toggleWebSearch() {
  isWebSearchEnabled = !isWebSearchEnabled;
  const indicator = document.getElementById("searchIndicator");
  if (indicator) indicator.style.display = isWebSearchEnabled ? "inline-flex" : "none";
  togglePopup();
}

function toggleDeepThink() {
  isDeepThinkEnabled = !isDeepThinkEnabled;
  const indicator = document.getElementById("thinkIndicator");
  if (indicator) indicator.style.display = isDeepThinkEnabled ? "inline-flex" : "none";
  togglePopup();
}

// =====================================================================
// VOICE CHAT (SPEECH SYNTHESIS & STT RECOGNITION)
// =====================================================================
let isRecording = false;
let mediaRecorder = null;
let audioChunks = [];

function startVoiceChat() {
  const btn = document.getElementById("btnVoiceChat");
  if (isRecording) {
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      mediaRecorder.stop();
    }
    btn.innerHTML = `<i class="fa-solid fa-microphone"></i>`;
    isRecording = false;
    return;
  }

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    alert("Audio recording not supported in this browser.");
    return;
  }

  navigator.mediaDevices.getUserMedia({ audio: true })
    .then(stream => {
      isRecording = true;
      audioChunks = [];
      const mimeType =
    MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";

mediaRecorder = new MediaRecorder(stream, {
    mimeType
});
      btn.innerHTML = `<i class="fa-solid fa-stop" style="color:red"></i>`;

      mediaRecorder.ondataavailable = e => {
        if (e.data.size > 0) audioChunks.push(e.data);
      };

      mediaRecorder.onstop = () => {
        const audioBlob = new Blob(audioChunks, {
    type: mediaRecorder.mimeType
});
        sendVoiceBlob(audioBlob);
        stream.getTracks().forEach(track => track.stop());
      };

      mediaRecorder.start();
    })
    .catch(err => {
      alert("Microphone access denied: " + err.message);
    });
}

async function sendVoiceBlob(blob) {
  const formData = new FormData();
  formData.append("audio", blob, "voice.webm");

  const loadingMsg = addMessageToUI("🎤 Processing voice transmission...", "user");

  if (!csrfToken) await fetchCsrfToken();
  fetch(`${API_BASE}/api/voice/stt`, {
    method: "POST",
    headers: { "X-CSRF-Token": csrfToken || "" },
    body: formData,
    credentials: "include"
  })
  .then(res => res.json())
  .then(data => {
    if (data.ok && data.transcript) {
      loadingMsg.innerHTML = data.transcript;
      inputMessage(data.transcript);
    } else {
      loadingMsg.innerHTML = `⚠️ Could not transcribe audio: ${data.error || "Unknown error"}`;
    }
  })
  .catch(err => {
    loadingMsg.innerHTML = "⚠️ STT Server error: " + err.message;
  });
}

// =====================================================================
// VOICE RESPONSE (TEXT-TO-SPEECH) — SETTINGS & CONTROLS
// =====================================================================
let voiceSettings = loadVoiceSettings();
let availableVoices = [];
let currentUtterance = null;
let ttsState = "idle"; // idle | speaking | paused

function loadVoiceSettings() {
  try {
    // Default OFF, per spec — voice response must be an explicit opt-in.
    return Object.assign({ enabled: false, voiceURI: "", rate: 1, pitch: 1 },
      JSON.parse(localStorage.getItem("syra_voice_settings") || "{}"));
  } catch (e) {
    return { enabled: false, voiceURI: "", rate: 1, pitch: 1 };
  }
}
function saveVoiceSettings() {
  localStorage.setItem("syra_voice_settings", JSON.stringify(voiceSettings));
}
function isVoiceResponseEnabled() {
  return !!voiceSettings.enabled;
}
function toggleVoiceResponse(forceValue) {
  voiceSettings.enabled = typeof forceValue === "boolean" ? forceValue : !voiceSettings.enabled;
  saveVoiceSettings();
  if (!voiceSettings.enabled) stopSpeaking();
  return voiceSettings.enabled;
}
function setVoiceURI(uri) { voiceSettings.voiceURI = uri; saveVoiceSettings(); }
function setVoiceRate(rate) { voiceSettings.rate = parseFloat(rate) || 1; saveVoiceSettings(); }
function setVoicePitch(pitch) { voiceSettings.pitch = parseFloat(pitch) || 1; saveVoiceSettings(); }

function refreshVoiceList() {
  if (!("speechSynthesis" in window)) return;
  availableVoices = window.speechSynthesis.getVoices();
}
if ("speechSynthesis" in window) {
  refreshVoiceList();
  window.speechSynthesis.onvoiceschanged = refreshVoiceList;
}

// speakText(text) — manual/replay play. speakText(text, {auto:true}) is the
// form used for "read AI responses automatically", and silently no-ops
// unless the user has turned Voice Response ON.
function speakText(text, opts = {}) {
  if (opts.auto && !isVoiceResponseEnabled()) return;
  if (!("speechSynthesis" in window) || !text) return;
  stopSpeaking();
  const cleanText = text.replace(/[*#`_~[\]]/g, "").replace(/=== FILE:.*?===/g, "");
  const utterance = new SpeechSynthesisUtterance(cleanText);
  const chosen = availableVoices.find(v => v.voiceURI === voiceSettings.voiceURI);
  if (chosen) utterance.voice = chosen;
  utterance.rate = voiceSettings.rate;
  utterance.pitch = voiceSettings.pitch;
  utterance.onstart = () => { ttsState = "speaking"; };
  utterance.onend = () => { ttsState = "idle"; currentUtterance = null; if (opts.onend) opts.onend(); };
  utterance.onerror = () => { ttsState = "idle"; currentUtterance = null; if (opts.onend) opts.onend(); };
  currentUtterance = utterance;
  currentUtterance._lastText = text;
  window.speechSynthesis.speak(utterance);
}
function pauseSpeaking() {
  if ("speechSynthesis" in window && ttsState === "speaking") {
    window.speechSynthesis.pause();
    ttsState = "paused";
  }
}
function resumeSpeaking() {
  if ("speechSynthesis" in window && ttsState === "paused") {
    window.speechSynthesis.resume();
    ttsState = "speaking";
  }
}
function stopSpeaking() {
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  ttsState = "idle";
  currentUtterance = null;
}
function replaySpeaking(text) {
  const t = text || (currentUtterance && currentUtterance._lastText);
  if (t) speakText(t);
}

// Adds a small Play/Pause/Resume/Stop/Replay row under an AI message.
function attachSpeechControls(container, text) {
  if (!("speechSynthesis" in window) || !text || !container) return;
  const bar = document.createElement("div");
  bar.className = "tts-controls";
  bar.style.cssText = "display:flex;gap:10px;margin-top:6px;font-size:13px;opacity:0.85;";

  const mkBtn = (label, title, handler) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.title = title;
    b.style.cssText = "background:none;border:none;color:inherit;cursor:pointer;font-size:13px;padding:0;";
    b.onclick = handler;
    return b;
  };

  bar.appendChild(mkBtn("▶️", "Play", () => speakText(text)));
  bar.appendChild(mkBtn("⏸️", "Pause", pauseSpeaking));
  bar.appendChild(mkBtn("⏵", "Resume", resumeSpeaking));
  bar.appendChild(mkBtn("⏹️", "Stop", stopSpeaking));
  bar.appendChild(mkBtn("🔁", "Replay", () => replaySpeaking(text)));
  container.appendChild(bar);
}

// Self-contained floating settings panel (built at runtime so it works
// regardless of what markup exists in index.html) covering the toggle,
// voice selection, speed, and pitch — everything persisted to localStorage.
function injectVoiceMenuEntry() {
  const popup = document.getElementById("popupMenu");
  if (popup && !document.getElementById("voiceSettingsMenuItem")) {
    const item = document.createElement("div");
    item.id = "voiceSettingsMenuItem";
    item.className = "popup-item";
    item.textContent = "🔊 Voice Response Settings";
    item.style.cursor = "pointer";
    item.onclick = () => { togglePopup(); openVoiceSettingsPanel(); };
    popup.appendChild(item);
  }
}

function openVoiceSettingsPanel() {
  let panel = document.getElementById("voiceSettingsPanel");
  if (panel) {
    panel.style.display = "flex";
    populateVoiceSelect(document.getElementById("voiceSelect"));
    return;
  }

  panel = document.createElement("div");
  panel.id = "voiceSettingsPanel";
  panel.style.cssText = "position:fixed;bottom:80px;right:16px;z-index:9999;background:rgba(20,20,30,0.95);backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,0.15);border-radius:14px;padding:14px;width:260px;color:#fff;font-size:13px;display:flex;flex-direction:column;gap:10px;box-shadow:0 8px 30px rgba(0,0,0,0.4);";
  panel.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;">
      <b>🔊 Voice Response</b>
      <button type="button" id="closeVoicePanelBtn" style="background:none;border:none;color:#fff;cursor:pointer;font-size:15px;">✖</button>
    </div>
    <label style="display:flex;align-items:center;gap:8px;">
      <input type="checkbox" id="voiceEnabledToggle"> Speak responses automatically
    </label>
    <label>Voice
      <select id="voiceSelect" style="width:100%;margin-top:4px;"></select>
    </label>
    <label>Speed <span id="voiceRateVal"></span>
      <input type="range" id="voiceRateRange" min="0.5" max="2" step="0.1" style="width:100%;">
    </label>
    <label>Pitch <span id="voicePitchVal"></span>
      <input type="range" id="voicePitchRange" min="0" max="2" step="0.1" style="width:100%;">
    </label>
  `;
  document.body.appendChild(panel);

  document.getElementById("closeVoicePanelBtn").onclick = () => { panel.style.display = "none"; };

  const enabledToggle = document.getElementById("voiceEnabledToggle");
  const rateRange = document.getElementById("voiceRateRange");
  const pitchRange = document.getElementById("voicePitchRange");
  const rateVal = document.getElementById("voiceRateVal");
  const pitchVal = document.getElementById("voicePitchVal");
  const select = document.getElementById("voiceSelect");

  enabledToggle.checked = voiceSettings.enabled;
  rateRange.value = voiceSettings.rate;
  pitchRange.value = voiceSettings.pitch;
  rateVal.textContent = voiceSettings.rate + "x";
  pitchVal.textContent = voiceSettings.pitch;

  populateVoiceSelect(select);

  enabledToggle.onchange = () => toggleVoiceResponse(enabledToggle.checked);
  rateRange.oninput = () => { setVoiceRate(rateRange.value); rateVal.textContent = rateRange.value + "x"; };
  pitchRange.oninput = () => { setVoicePitch(pitchRange.value); pitchVal.textContent = pitchRange.value; };
  select.onchange = () => setVoiceURI(select.value);
}

function populateVoiceSelect(select) {
  if (!select) return;
  refreshVoiceList();
  select.innerHTML = '<option value="">System Default</option>' +
    availableVoices.map(v =>
      `<option value="${escapeHtml(v.voiceURI)}" ${v.voiceURI === voiceSettings.voiceURI ? "selected" : ""}>${escapeHtml(v.name)} (${escapeHtml(v.lang)})</option>`
    ).join("");
}

function inputMessage(text) {
  const msgInput = document.getElementById("messageInput");
  msgInput.value = text;
  sendMessage();
}

// =====================================================================
// TEXT STREAMING CORE
// =====================================================================
function initTextareaResizer() {
  const textarea = document.getElementById("messageInput");
  if (!textarea) return;
  textarea.addEventListener("input", function() {
    this.style.height = "auto";
    this.style.height = this.scrollHeight + "px";
  });
  textarea.addEventListener("keydown", function(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
}

async function sendMessage() {
  if (isProcessing) return;

  const inputEl = document.getElementById("messageInput");
  const query = inputEl.value.trim();
  const attachment = pendingAttachment;

  if (!query && !attachment) return;

  isProcessing = true;
  inputEl.value = "";
  inputEl.style.height = "auto";
  inputEl.disabled = true;
  clearAttachment();

  const sendBtn = document.getElementById("sendBtn");
  if (sendBtn) sendBtn.classList.add("disabled");

  const displayText = query || `📎 ${attachment.file.name}`;
  addMessageToUI(displayText, "user");

  const loaderBox = document.createElement("div");
  loaderBox.className = "msg bot";
  loaderBox.innerHTML = `<span class="thinking-span">💬 SYRA is processing...</span>`;
  const chatArea = document.getElementById("chat");
  chatArea.appendChild(loaderBox);
  scrollChatBottom();

  const finishUp = () => {
    isProcessing = false;
    inputEl.disabled = false;
    if (sendBtn) sendBtn.classList.remove("disabled");
    inputEl.focus();
    saveCurrentSession();
  };

  // An attached image is routed straight to Vision — it's a self-contained
  // exchange (upload -> analyze -> answer), not folded into the chat stream.
  if (attachment && attachment.category === "image") {
    try {
      await uploadAndAnalyzeImage(attachment.file, query, loaderBox);
    } catch (err) {
      loaderBox.innerHTML = `⚠️ Vision request failed: ${escapeHtml(err.message)}`;
    }
    finishUp();
    return;
  }

  // An attached document/code file is uploaded first; its extracted text
  // preview is folded into the outgoing chat message as context so the
  // model can actually answer questions about it in the same turn.
  let effectiveMessage = query;
  if (attachment) {
    try {
      const uploadResult = await uploadDatasetFile(attachment.file, loaderBox);
      if (uploadResult.preview) {
        effectiveMessage = `${query ? query + "\n\n" : ""}[Attached file "${attachment.file.name}":\n${uploadResult.preview}\n]`;
      }
      loaderBox.innerHTML = `<span class="thinking-span">💬 SYRA is processing...</span>`;
    } catch (err) {
      loaderBox.innerHTML = `⚠️ Upload failed: ${escapeHtml(err.message)}`;
      finishUp();
      return;
    }
    if (!query) {
      // File-only send with no question — report the upload result and stop.
      loaderBox.innerHTML = `✅ Uploaded <b>${escapeHtml(attachment.file.name)}</b>. Ask me anything about it.`;
      finishUp();
      return;
    }
  }

  abortController = new AbortController();

  let streamContainer = null;
  let loaderRemoved = false;

  try {
    // Logged-in users are identified server-side via the session cookie
    // (resolve_session_id() in app.py); session_id here is only a fallback
    // bucket key for guests, read from the profile auth.js caches on
    // successful login (see auth.js's onAuthSuccess/reflectSessionInUI).
    const cachedProfile = JSON.parse(localStorage.getItem(CACHED_USER_KEY) || "null");
    if (!currentConversationId) currentConversationId = genConvId();
    const payload = {
      message: effectiveMessage,
      model: isDeepThinkEnabled ? "deepseek" : activeModel,
      session_id: (cachedProfile && cachedProfile.email) || "anon",
      mode: activeChatMode,
      web_search: isWebSearchEnabled,
      conversation_id: currentConversationId
    };

    // Mode-specific routing: Image and Project modes use direct APIs instead of chat stream
    if (activeChatMode === "image" && !attachment) {
      finishUp();
      generateImage(effectiveMessage);
      return;
    }

    if (activeChatMode === "website" && !attachment) {
      finishUp();
      buildWebsite(effectiveMessage, "html");
      return;
    }

    if (activeChatMode === "project" && !attachment) {
      finishUp();
      buildProject(effectiveMessage, "React");
      return;
    }

    if (!csrfToken) await fetchCsrfToken();
    const response = await fetch(`${API_BASE}/api/chat/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken || "" },
      credentials: "include",
      body: JSON.stringify(payload),
      signal: abortController.signal
    });

    if (loaderBox.parentNode) {
      loaderBox.remove();
      loaderRemoved = true;
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => "Unknown error");
      addMessageToUI(`⚠️ Server error (${response.status}): ${errText}`, "bot");
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let done = false;
    let fullResponseText = "";
    let buffer = "";

    streamContainer = document.createElement("div");
    streamContainer.className = "msg bot";
    chatArea.appendChild(streamContainer);

    while (!done) {
      const { value, done: streamDone } = await reader.read();
      done = streamDone;
      if (value) {
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n\n");
        // Keep last partial chunk in buffer
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const dataStr = line.slice(6).trim();
          if (dataStr === "[DONE]") {
            done = true;
            break;
          }
          const dataObj = jsonParseSafe(dataStr);
          if (!dataObj) continue;

          if (dataObj.conversation_id) {
            currentConversationId = dataObj.conversation_id;
            continue;
          }

          if (dataObj.error) {
            streamContainer.innerHTML = `⚠️ AI error: ${dataObj.error}`;
            done = true;
            break;
          }

          // Image response from stream
          if (dataObj.type === "image" && dataObj.url) {
            streamContainer.innerHTML = renderImageResponse(dataObj.url, dataObj.prompt || query);
            fullResponseText = `[Image generated for: ${dataObj.prompt || query}]`;
            saveCurrentSession();
            done = true;
            break;
          }

          // Normal text chunk
          if (dataObj.text) {
            fullResponseText += dataObj.text;
            streamContainer.innerHTML = formatMarkdown(fullResponseText);
            scrollChatBottom();
          }
        }
      }
    }

    // Flush any remaining buffer
    if (buffer.startsWith("data: ")) {
      const dataStr = buffer.slice(6).trim();
      if (dataStr && dataStr !== "[DONE]") {
        const dataObj = jsonParseSafe(dataStr);
        if (dataObj && dataObj.text) {
          fullResponseText += dataObj.text;
          if (streamContainer) streamContainer.innerHTML = formatMarkdown(fullResponseText);
        }
      }
    }

    const isBuilderReply = (activeChatMode === "website" || activeChatMode === "project") && /===\s*FILE:/i.test(fullResponseText);

    if (isBuilderReply && streamContainer) {
      // The model returned file blocks inline via the chat stream (rather
      // than the dedicated /api/website|project/generate endpoints) — give
      // it the same File Explorer + preview treatment, just without a ZIP
      // link since no server-side project/zip was created for this path.
      renderProjectResult(streamContainer, { code: fullResponseText }, activeChatMode);
    } else if (fullResponseText && !fullResponseText.startsWith("[Image") && streamContainer) {
      attachSpeechControls(streamContainer, fullResponseText);
      if (isVoiceResponseEnabled()) speakText(fullResponseText, { auto: true });
    }

    // ChatGPT-style per-message action bar (Like/Dislike/Copy/Read Aloud/
    // Regenerate) — purely additive UI layer, doesn't alter the routing,
    // streaming, or rendering logic above.
    if (streamContainer && fullResponseText) {
      attachActionBarOnly(streamContainer, fullResponseText);
    }

  } catch (err) {
    if (err.name !== "AbortError") {
      if (!loaderRemoved && loaderBox.parentNode) loaderBox.remove();
      const errMsg = streamContainer || addMessageToUI("", "bot");
      errMsg.innerHTML = `⚠️ Connection error: ${err.message}`;
    }
  } finally {
    finishUp();
  }
}

function renderImageResponse(url, prompt) {
  return `
    <div class="image-response">
      <p>🎨 <b>Generated:</b> ${escapeHtml(prompt)}</p>
      <img src="${escapeHtml(url)}" alt="Generated image" style="max-width:100%;border-radius:12px;margin-top:8px;" onerror="this.alt='Image failed to load'">
      <br>
      <a href="${escapeHtml(url)}" download="syra-image.png" target="_blank" style="display:inline-block;margin-top:8px;padding:6px 14px;background:rgba(255,255,255,0.15);border-radius:8px;color:inherit;text-decoration:none;">⬇️ Download</a>
    </div>`;
}

function escapeHtml(text) {
  const d = document.createElement("div");
  d.appendChild(document.createTextNode(text || ""));
  return d.innerHTML;
}

function stopGeneration() {
  if (abortController) {
    abortController.abort();
  }
}

function regenerate() {
  const chatArea = document.getElementById("chat");
  const messages = chatArea.querySelectorAll(".msg.user");
  if (messages.length > 0) {
    const lastUserQuery = messages[messages.length - 1].textContent.trim();
    if (lastUserQuery) inputMessage(lastUserQuery);
  }
}

function addMessageToUI(text, sender) {
  const d = document.createElement("div");
  d.className = "msg " + sender;
  d.innerHTML = sender === "bot" ? formatMarkdown(text) : escapeHtml(text);
  if (sender === "user") d.dataset.rawB64 = encodeRawText(text);
  document.getElementById("chat").appendChild(d);
  scrollChatBottom();
  return d;
}

function scrollChatBottom() {
  const chatBox = document.getElementById("chat");
  if (chatBox) chatBox.scrollTop = chatBox.scrollHeight;
}

function formatMarkdown(t) {
  if (!t) return "";

  // Pull out code blocks first and replace with placeholders so we can
  // escape the rest of the text safely without double-escaping code.
  const codeBlocks = [];
  let working = t.replace(/```(\w+)?\n?([\s\S]*?)```/g, (_, lang, code) => {
    const idx = codeBlocks.length;
    const langLabel = (lang || "text").trim();
    const codeId = "chatcode_" + Date.now().toString(36) + "_" + idx + "_" + Math.random().toString(36).slice(2, 7);
    codeBlocks.push(
      `<div class="chat-code-block">` +
        `<div class="chat-code-header">` +
          `<span class="chat-code-lang">${escapeHtml(langLabel)}</span>` +
          `<button type="button" class="chat-code-copy-btn" data-target="${codeId}" onclick="copyChatCodeBlock(this)" aria-label="Copy code block">` +
            `<span class="chat-code-copy-icon">📋</span><span class="chat-code-copy-label">Copy</span>` +
          `</button>` +
        `</div>` +
        `<pre><code id="${codeId}" class="lang-${escapeHtml(langLabel)}">${escapeHtml(code.trim())}</code></pre>` +
      `</div>`
    );
    return `\u0000CODEBLOCK${idx}\u0000`;
  });

  // Escape everything else as plain text BEFORE turning markdown syntax
  // into HTML. This is what prevents untrusted model output (or file
  // names, prompts, etc.) from injecting live HTML/script into the page.
  working = escapeHtml(working);

  // Re-expand <thinking> blocks (operate after escaping, matching the
  // escaped tag form) and apply markdown-style replacements.
  working = working
    .replace(/&lt;thinking&gt;([\s\S]*?)&lt;\/thinking&gt;/gi, '<div class="thinking-block"><b>🧠 System Thought:</b><br>$1</div>')
    .replace(/\*\*(.*?)\*\*/g, '<b>$1</b>')
    .replace(/\*(.*?)\*/g, '<i>$1</i>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/^[-*] (.+)$/gm, '<li>$1</li>')
    .replace(/\n/g, '<br>')
    .replace(/=== FILE:\s*(.+?)\s*===/g, '<div style="margin-top:10px;padding:6px;background:#000;font-size:11px;border-radius:4px;">📂 File: $1</div>');

  // Restore code blocks (already safely escaped above, inserted as real HTML).
  working = working.replace(/\u0000CODEBLOCK(\d+)\u0000/g, (_, idx) => codeBlocks[Number(idx)]);

  return working;
}

// =====================================================================
// CHATGPT-STYLE MESSAGE ACTION BAR
// (Additive UI layer only — reuses existing endpoints, TTS engine, and
// clipboard fallback. Does not alter chat streaming, routing, or backend
// calls used elsewhere in this file.)
// =====================================================================

// Raw (pre-markdown) message text is stashed on each bubble as base64 in
// a data-attribute so Copy Response / Regenerate can recover the exact
// original text regardless of how the bubble's HTML was produced
// (live stream, vision reply, or reloaded conversation history).
function encodeRawText(str) {
  try { return btoa(unescape(encodeURIComponent(str || ""))); } catch (e) { return ""; }
}
function decodeRawText(str) {
  try { return decodeURIComponent(escape(atob(str || ""))); } catch (e) { return ""; }
}

// Converts raw markdown into clean plain text for "Copy Response":
// strips code fences/markdown syntax but keeps code content and line breaks.
function stripMarkdownForCopy(raw) {
  if (!raw) return "";
  let text = raw.replace(/```(?:\w+)?\n?([\s\S]*?)```/g, (_, code) => code.replace(/\n$/, ""));
  text = text
    .replace(/<thinking>([\s\S]*?)<\/thinking>/gi, "$1")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/\*(.*?)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^[-*]\s+/gm, "• ")
    .replace(/=== FILE:\s*(.+?)\s*===/g, "File: $1");
  return text.trim();
}

// Shared clipboard helper (reuses the existing fallbackCopy() defined
// below for browsers/contexts without the async Clipboard API).
function copyToClipboard(value, onDone) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(value).then(onDone).catch(() => fallbackCopy(value, onDone));
  } else {
    fallbackCopy(value, onDone);
  }
}

// Copy button that floats over every Markdown code block rendered by
// formatMarkdown().
function copyChatCodeBlock(btn) {
  const id = btn.getAttribute("data-target");
  const codeEl = document.getElementById(id);
  if (!codeEl) return;
  copyToClipboard(codeEl.textContent, () => {
    const label = btn.querySelector(".chat-code-copy-label");
    const icon = btn.querySelector(".chat-code-copy-icon");
    btn.classList.add("copied");
    btn.setAttribute("aria-label", "Copied to clipboard");
    if (label) label.textContent = "Copied";
    if (icon) icon.textContent = "✓";
    clearTimeout(btn._copyResetTimer);
    btn._copyResetTimer = setTimeout(() => {
      btn.classList.remove("copied");
      btn.setAttribute("aria-label", "Copy code block");
      if (label) label.textContent = "Copy";
      if (icon) icon.textContent = "📋";
    }, 2000);
  });
}

// Markup for the action bar (Like / Dislike / Copy / Read Aloud / Regenerate).
// Built as a string (not DOM nodes) so it renders correctly whether it's
// appended live or baked into a cached/reloaded conversation's HTML.
function actionBarTemplateHTML() {
  return (
    '<div class="msg-action-bar" role="group" aria-label="Message actions">' +
      '<button type="button" class="msg-action-btn" data-action="like" aria-label="Like this response" aria-pressed="false" title="Like" onclick="handleMsgAction(this)">👍</button>' +
      '<button type="button" class="msg-action-btn" data-action="dislike" aria-label="Dislike this response" aria-pressed="false" title="Dislike" onclick="handleMsgAction(this)">👎</button>' +
      '<button type="button" class="msg-action-btn" data-action="copy" aria-label="Copy response" title="Copy response" onclick="handleMsgAction(this)"><span class="msg-action-icon">📋</span></button>' +
      '<button type="button" class="msg-action-btn" data-action="speak" aria-label="Read response aloud" title="Read aloud" onclick="handleMsgAction(this)"><span class="msg-action-icon">🔊</span></button>' +
      '<button type="button" class="msg-action-btn" data-action="regenerate" aria-label="Regenerate response" title="Regenerate" onclick="handleMsgAction(this)"><span class="msg-action-icon">↻</span></button>' +
    '</div>'
  );
}

function appendActionBar(container) {
  if (!container || container.querySelector(":scope > .msg-action-bar")) return;
  container.insertAdjacentHTML("beforeend", actionBarTemplateHTML());
}

// Stores the raw text on the bubble and appends the action bar — call
// this once a bot bubble's final content is known.
function attachActionBarOnly(container, rawText) {
  if (!container || !rawText) return;
  container.dataset.rawB64 = encodeRawText(rawText);
  appendActionBar(container);
}

// Builds a full history bubble (used when reloading a saved conversation)
// with the same raw-text storage + action bar treatment as live messages.
function buildHistoryMessageHTML(m) {
  const isBot = m.role === "assistant";
  const encoded = encodeRawText(m.content || "");
  if (isBot) {
    return `<div class="msg bot" data-raw-b64="${encoded}">${formatMarkdown(m.content)}${actionBarTemplateHTML()}</div>`;
  }
  return `<div class="msg user" data-raw-b64="${encoded}">${escapeHtml(m.content)}</div>`;
}

let currentSpeakBtn = null;
function resetSpeakBtn(btn) {
  if (!btn) return;
  const icon = btn.querySelector(".msg-action-icon");
  if (icon) icon.textContent = "🔊";
  btn.classList.remove("speaking");
  btn.setAttribute("aria-label", "Read response aloud");
}
function toggleSpeakForButton(btn, text) {
  if (!text) return;
  if (currentSpeakBtn === btn && ttsState === "speaking") {
    stopSpeaking();
    resetSpeakBtn(btn);
    currentSpeakBtn = null;
    return;
  }
  if (currentSpeakBtn) resetSpeakBtn(currentSpeakBtn);
  currentSpeakBtn = btn;
  const icon = btn.querySelector(".msg-action-icon");
  if (icon) icon.textContent = "⏹️";
  btn.classList.add("speaking");
  btn.setAttribute("aria-label", "Stop reading aloud");
  speakText(text, {
    onend: () => {
      resetSpeakBtn(btn);
      if (currentSpeakBtn === btn) currentSpeakBtn = null;
    }
  });
}

function handleMsgAction(btn) {
  const action = btn.getAttribute("data-action");
  const msgEl = btn.closest(".msg");
  if (!msgEl) return;
  const rawText = decodeRawText(msgEl.dataset.rawB64 || "");

  if (action === "like" || action === "dislike") {
    const other = msgEl.querySelector(`.msg-action-btn[data-action="${action === "like" ? "dislike" : "like"}"]`);
    const nowActive = btn.getAttribute("aria-pressed") !== "true";
    btn.setAttribute("aria-pressed", String(nowActive));
    btn.classList.toggle("active", nowActive);
    if (nowActive && other) {
      other.setAttribute("aria-pressed", "false");
      other.classList.remove("active");
    }
  } else if (action === "copy") {
    const clean = stripMarkdownForCopy(rawText);
    copyToClipboard(clean, () => {
      const icon = btn.querySelector(".msg-action-icon");
      btn.classList.add("copied");
      btn.setAttribute("aria-label", "Copied to clipboard");
      if (icon) icon.textContent = "✓";
      clearTimeout(btn._copyResetTimer);
      btn._copyResetTimer = setTimeout(() => {
        btn.classList.remove("copied");
        btn.setAttribute("aria-label", "Copy response");
        if (icon) icon.textContent = "📋";
      }, 2000);
    });
  } else if (action === "speak") {
    toggleSpeakForButton(btn, rawText);
  } else if (action === "regenerate") {
    regenerateFromBar(msgEl);
  }
}

// Regenerates a single assistant reply in place: reuses the same
// /api/chat/stream endpoint sendMessage() uses, does not add a new user
// bubble, and swaps the existing bubble's content once the new reply
// finishes streaming.
async function regenerateFromBar(msgEl) {
  if (!msgEl || isProcessing) return;
  const userEl = msgEl.previousElementSibling;
  if (!userEl || !userEl.classList || !userEl.classList.contains("user")) return;
  const lastUserQuery = userEl.dataset.rawB64 ? decodeRawText(userEl.dataset.rawB64) : userEl.textContent.trim();
  if (!lastUserQuery) return;

  isProcessing = true;
  const regenBtn = msgEl.querySelector('.msg-action-btn[data-action="regenerate"]');
  if (regenBtn) regenBtn.classList.add("spinning");
  if (currentSpeakBtn && msgEl.contains(currentSpeakBtn)) { stopSpeaking(); currentSpeakBtn = null; }

  msgEl.innerHTML = `<span class="thinking-span">💬 SYRA is regenerating...</span>`;
  scrollChatBottom();

  try {
    if (!csrfToken) await fetchCsrfToken();
    const cachedProfile = JSON.parse(localStorage.getItem(CACHED_USER_KEY) || "null");
    const payload = {
      message: lastUserQuery,
      model: isDeepThinkEnabled ? "deepseek" : activeModel,
      session_id: (cachedProfile && cachedProfile.email) || "anon",
      mode: activeChatMode,
      web_search: isWebSearchEnabled,
      conversation_id: currentConversationId
    };
    const response = await fetch(`${API_BASE}/api/chat/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken || "" },
      credentials: "include",
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "Unknown error");
      msgEl.innerHTML = `⚠️ Server error (${response.status}): ${escapeHtml(errText)}`;
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let done = false, fullResponseText = "", buffer = "";

    while (!done) {
      const { value, done: streamDone } = await reader.read();
      done = streamDone;
      if (value) {
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const dataStr = line.slice(6).trim();
          if (dataStr === "[DONE]") { done = true; break; }
          const dataObj = jsonParseSafe(dataStr);
          if (!dataObj) continue;
          if (dataObj.conversation_id) { currentConversationId = dataObj.conversation_id; continue; }
          if (dataObj.error) { msgEl.innerHTML = `⚠️ AI error: ${escapeHtml(dataObj.error)}`; done = true; break; }
          if (dataObj.type === "image" && dataObj.url) {
            msgEl.innerHTML = renderImageResponse(dataObj.url, dataObj.prompt || lastUserQuery);
            fullResponseText = `[Image generated for: ${dataObj.prompt || lastUserQuery}]`;
            done = true;
            break;
          }
          if (dataObj.text) {
            fullResponseText += dataObj.text;
            msgEl.innerHTML = formatMarkdown(fullResponseText);
            scrollChatBottom();
          }
        }
      }
    }

    if (fullResponseText) {
      const isBuilderReply = (activeChatMode === "website" || activeChatMode === "project") && /===\s*FILE:/i.test(fullResponseText);
      if (isBuilderReply) {
        renderProjectResult(msgEl, { code: fullResponseText }, activeChatMode);
      } else if (!fullResponseText.startsWith("[Image")) {
        attachSpeechControls(msgEl, fullResponseText);
      }
      attachActionBarOnly(msgEl, fullResponseText);
      saveCurrentSession();
    }
  } catch (err) {
    msgEl.innerHTML = `⚠️ Connection error: ${escapeHtml(err.message)}`;
  } finally {
    isProcessing = false;
    if (regenBtn) regenBtn.classList.remove("spinning");
  }
}

function jsonParseSafe(s) {
  try {
    return JSON.parse(s);
  } catch (e) {
    return null;
  }
}

// =====================================================================
// CHAT SESSION & SQLITE-BACKED PERSISTENCE
// (Conversations + messages live in the backend's SQLite tables; see
// /api/conversations* routes. `chats` is just a same-session HTML cache.)
// =====================================================================
function createNewSession(initialText = "👋 Dialogue Session Started") {
  const newChatHTML = `<div class="msg bot">${escapeHtml(initialText)}</div>`;
  if (!currentConversationId) currentConversationId = genConvId();
  chats[currentConversationId] = newChatHTML;
  const chatArea = document.getElementById("chat");
  if (chatArea) chatArea.innerHTML = newChatHTML;
  highlightActiveHistoryItem();
}

// Starts a brand new chat session from the workspace side menu. The
// conversation isn't written to SQLite until the first message is sent
// (mirrors ChatGPT-style "new chat" behavior) — resolve_conversation_id()
// on the backend auto-creates its row at that point.
function newChat() {
  activeChatMode = "general";
  isWebSearchEnabled = false;
  isDeepThinkEnabled = false;
  const searchIndicator = document.getElementById("searchIndicator");
  const thinkIndicator = document.getElementById("thinkIndicator");
  if (searchIndicator) searchIndicator.style.display = "none";
  if (thinkIndicator) thinkIndicator.style.display = "none";
  currentConversationId = genConvId();
  createNewSession("👋 New Session Started");
  toggleChatMenu(true);
}

// Called after every assistant reply finishes — refreshes the sidebar so
// a freshly-created conversation (auto-titled from the first message)
// shows up, and keeps the "updated_at" ordering current.
function saveCurrentSession() {
  const chatArea = document.getElementById("chat");
  if (!chatArea || !currentConversationId) return;
  chats[currentConversationId] = chatArea.innerHTML;
  refreshHistoryList();
}

// Loads a conversation's real messages from the backend and renders them.
async function openConversation(convId) {
  currentConversationId = convId;
  toggleChatMenu(true);

  if (chats[convId]) {
    const chatArea = document.getElementById("chat");
    if (chatArea) chatArea.innerHTML = chats[convId];
    scrollChatBottom();
    highlightActiveHistoryItem();
    return;
  }

  const chatArea = document.getElementById("chat");
  if (chatArea) chatArea.innerHTML = `<div class="msg bot"><span class="thinking-span">Loading conversation...</span></div>`;

  try {
    const { data } = await apiFetch(
      `${API_BASE}/api/conversations/${encodeURIComponent(convId)}?session_id=${encodeURIComponent(currentSessionIdParam())}`
    );
    if (data && data.ok) {
      const html = (data.messages || [])
        .map(buildHistoryMessageHTML)
        .join("");
      chats[convId] = html || `<div class="msg bot">👋 New conversation</div>`;
      if (chatArea) chatArea.innerHTML = chats[convId];
    } else {
      if (chatArea) chatArea.innerHTML = `<div class="msg bot">⚠️ Couldn't load that conversation.</div>`;
    }
  } catch (e) {
    if (chatArea) chatArea.innerHTML = `<div class="msg bot">⚠️ Network error loading conversation.</div>`;
  }
  scrollChatBottom();
  highlightActiveHistoryItem();
}

// Backward-compatible alias for any older call sites.
function loadChatSession(convId) {
  openConversation(convId);
}

async function refreshHistoryList() {
  try {
    const { data } = await apiFetch(`${API_BASE}/api/conversations?session_id=${encodeURIComponent(currentSessionIdParam())}`);
    conversationsMeta = (data && data.conversations) || [];
  } catch (e) {
    // keep whatever we last had
  }
  renderHistoryList(conversationsMeta);
}
function loadHistoryList() { refreshHistoryList(); }

function groupLabelFor(updatedAtIso) {
  const updated = new Date(updatedAtIso);
  const now = new Date();
  const startOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diffDays = Math.round((startOfDay(now) - startOfDay(updated)) / 86400000);
  if (diffDays <= 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays <= 7) return "Last 7 Days";
  return "Older";
}

function renderHistoryList(conversations) {
  const list = document.getElementById("chatHistory");
  if (!list) return;
  list.innerHTML = "";

  if (!conversations || conversations.length === 0) {
    const empty = document.createElement("div");
    empty.className = "history-empty-note";
    empty.textContent = "No saved chats yet — start typing to create one.";
    list.appendChild(empty);
    return;
  }

  const groups = { "Today": [], "Yesterday": [], "Last 7 Days": [], "Older": [] };
  const pinned = [];
  conversations.forEach(c => {
    if (c.pinned) { pinned.push(c); return; }
    groups[groupLabelFor(c.updated_at)].push(c);
  });

  const appendGroup = (label, items) => {
    if (!items.length) return;
    const header = document.createElement("div");
    header.className = "history-group-label";
    header.textContent = label;
    list.appendChild(header);
    items.forEach(c => list.appendChild(buildHistoryItemRow(c)));
  };

  appendGroup("📌 Pinned", pinned);
  appendGroup("Today", groups["Today"]);
  appendGroup("Yesterday", groups["Yesterday"]);
  appendGroup("Last 7 Days", groups["Last 7 Days"]);
  appendGroup("Older", groups["Older"]);
}

function buildHistoryItemRow(conv) {
  const row = document.createElement("div");
  row.className = "history-item-row" + (conv.id === currentConversationId ? " active" : "");
  row.dataset.convId = conv.id;

  const label = document.createElement("div");
  label.className = "history-item" + (conv.pinned ? " pinned" : "");
  label.textContent = conv.title || "New chat";
  label.title = conv.title || "New chat";
  label.onclick = () => openConversation(conv.id);

  const actions = document.createElement("div");
  actions.className = "history-item-actions";

  const mkBtn = (icon, title, handler) => {
    const b = document.createElement("button");
    b.type = "button";
    b.innerHTML = icon;
    b.title = title;
    b.onclick = (e) => { e.stopPropagation(); handler(); };
    return b;
  };

  actions.appendChild(mkBtn(conv.pinned ? "📌" : "📍", conv.pinned ? "Unpin" : "Pin", () => togglePinConversation(conv)));
  actions.appendChild(mkBtn("✏️", "Rename", () => renameConversationUI(conv)));
  actions.appendChild(mkBtn("🗑️", "Delete", () => deleteConversationUI(conv)));

  row.appendChild(label);
  row.appendChild(actions);
  return row;
}

function highlightActiveHistoryItem() {
  document.querySelectorAll(".history-item-row").forEach(row => {
    row.classList.toggle("active", row.dataset.convId === currentConversationId);
  });
}

async function togglePinConversation(conv) {
  await apiFetch(`${API_BASE}/api/conversations/${encodeURIComponent(conv.id)}`, {
    method: "PATCH",
    body: { session_id: currentSessionIdParam(), pinned: !conv.pinned }
  });
  refreshHistoryList();
}

async function renameConversationUI(conv) {
  const newTitle = prompt("Rename chat:", conv.title || "New chat");
  if (newTitle === null) return;
  const trimmed = newTitle.trim();
  if (!trimmed) return;
  await apiFetch(`${API_BASE}/api/conversations/${encodeURIComponent(conv.id)}`, {
    method: "PATCH",
    body: { session_id: currentSessionIdParam(), title: trimmed }
  });
  refreshHistoryList();
}

async function deleteConversationUI(conv) {
  if (!confirm(`Delete "${conv.title || 'this chat'}"? This cannot be undone.`)) return;
  await apiFetch(`${API_BASE}/api/conversations/${encodeURIComponent(conv.id)}?session_id=${encodeURIComponent(currentSessionIdParam())}`, {
    method: "DELETE"
  });
  delete chats[conv.id];
  if (currentConversationId === conv.id) {
    newChat();
  }
  refreshHistoryList();
}

// "Clear Session History" — wipes ALL saved conversations for this user
// from the SQLite backend (Settings > Clear Chat History uses this too).
function clearChats() {
  if (confirm("Delete ALL saved chat history? This action is permanent.")) {
    apiFetch(`${API_BASE}/api/chats/clear`, {
      method: "POST",
      body: { session_id: currentSessionIdParam() }
    }).finally(() => {
      chats = {};
      currentConversationId = genConvId();
      createNewSession("👋 Active cache restarted. Welcome back.");
      refreshHistoryList();
    });
  }
}

// Debounced search across conversation titles AND message content
// (server-side, via /api/conversations/search).
let _searchDebounceTimer = null;
function filterChats() {
  const input = document.getElementById("chatSearchInput");
  if (!input) return;
  clearTimeout(_searchDebounceTimer);
  const query = input.value.trim();
  _searchDebounceTimer = setTimeout(async () => {
    if (!query) {
      renderHistoryList(conversationsMeta);
      return;
    }
    try {
      const { data } = await apiFetch(
        `${API_BASE}/api/conversations/search?session_id=${encodeURIComponent(currentSessionIdParam())}&q=${encodeURIComponent(query)}`
      );
      renderHistoryList((data && data.conversations) || []);
    } catch (e) {
      renderHistoryList([]);
    }
  }, 250);
}

function toggleFolder() {
  const list = document.getElementById("chatHistory");
  if (!list) return;
  list.style.display = (list.style.display === "none") ? "flex" : "none";
}

function openSpecializedChat(mode) {
  activeChatMode = mode;
  currentConversationId = genConvId();
  openChat();
  createNewSession(`💻 Specialized ${mode.toUpperCase()} workspace established. Enter your task.`);
}

// Home dashboard shortcut card — jumps straight into the chat workspace
// primed for an image-generation request.
function openImageTab() {
  activeChatMode = "general";
  openChat();
  createNewSession("🎨 Image Generation Studio ready. Describe the artwork you'd like SYRA to create.");
}

// Home dashboard shortcut card — jumps into the chat workspace with web
// search enabled so replies are grounded in live results.
function openSearchTab() {
  activeChatMode = "general";
  isWebSearchEnabled = true;
  openChat();
  createNewSession("🧠 Deep Web Search enabled. Ask me anything and I'll ground my answer in live results.");
  const indicator = document.getElementById("searchIndicator");
  if (indicator) indicator.style.display = "inline-flex";
}

// =====================================================================
// PROJECT RESULT UI — File Explorer + Desktop/Tablet/Mobile Preview
// =====================================================================
// Mirrors the backend's === FILE: path === parser so the explorer can be
// built purely from the `code` field already in the API response.
function parseFilesClient(content) {
  const files = {};
  const regex = /===\s*FILE:\s*(.+?)\s*===\n([\s\S]*?)(?=(?:===\s*FILE:)|$)/gi;
  let match;
  while ((match = regex.exec(content || "")) !== null) {
    const path = match[1].trim();
    let code = match[2].trim();
    code = code.replace(/^```[a-zA-Z0-9]*\n/, "").replace(/\n```$/, "");
    files[path] = code.trim();
  }
  if (Object.keys(files).length === 0 && content) {
    files["output.txt"] = content;
  }
  return files;
}

// Inlines matching CSS/JS into the HTML file so it can be shown in an
// iframe via srcdoc without needing real hosting.
function buildPreviewDoc(files) {
  const names = Object.keys(files);
  const htmlFile = names.find(f => /(^|\/)index\.html$/i.test(f)) || names.find(f => /\.html?$/i.test(f));
  if (!htmlFile) return null;
  let html = files[htmlFile];
  const cssFile = names.find(f => /\.css$/i.test(f));
  const jsFile = names.find(f => /\.js$/i.test(f));
  if (cssFile && !/<link[^>]*stylesheet/i.test(html)) {
    html = /<\/head>/i.test(html) ? html.replace(/<\/head>/i, `<style>${files[cssFile]}</style></head>`) : `<style>${files[cssFile]}</style>` + html;
  }
  if (jsFile && !/<script[^>]*src=/i.test(html)) {
    html = /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `<script>${files[jsFile]}<\/script></body>`) : html + `<script>${files[jsFile]}<\/script>`;
  }
  return html;
}

function renderProjectResult(container, data, kind) {
  const files = parseFilesClient(data.code || "");
  const fileNames = Object.keys(files);
  const previewDoc = buildPreviewDoc(files);
  const boxId = "proj_" + Math.random().toString(36).slice(2, 9);

  let html = `<div class="project-result" id="${boxId}">
    <p>✅ <b>${kind === "website" ? "Website" : "Project"} generated!</b></p>
    <div class="project-toolbar" style="display:flex;flex-wrap:wrap;gap:6px;margin:8px 0;">`;
  if (data.download) {
    html += `<a href="${escapeHtml(data.download)}" target="_blank" style="padding:6px 12px;background:rgba(255,255,255,0.15);border-radius:8px;color:inherit;text-decoration:none;font-size:12px;">⬇️ Download ZIP / Source</a>`;
  }
  if (previewDoc) {
    html += `
      <button type="button" class="preview-btn" data-view="desktop" style="padding:6px 12px;border-radius:8px;border:none;background:rgba(255,255,255,0.1);color:inherit;font-size:12px;cursor:pointer;">🖥️ Desktop</button>
      <button type="button" class="preview-btn" data-view="tablet" style="padding:6px 12px;border-radius:8px;border:none;background:rgba(255,255,255,0.1);color:inherit;font-size:12px;cursor:pointer;">📱 Tablet</button>
      <button type="button" class="preview-btn" data-view="mobile" style="padding:6px 12px;border-radius:8px;border:none;background:rgba(255,255,255,0.1);color:inherit;font-size:12px;cursor:pointer;">📱 Mobile</button>`;
  }
  html += `</div>
    <div class="file-explorer" style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px;">
      ${fileNames.map((f, i) => `<button type="button" class="file-tab" data-idx="${i}" style="padding:4px 10px;font-size:11px;border-radius:6px;border:none;background:${i === 0 ? "rgba(255,255,255,0.25)" : "rgba(255,255,255,0.08)"};color:inherit;cursor:pointer;">📄 ${escapeHtml(f)}</button>`).join("")}
    </div>
    <pre class="file-content-view" style="max-height:280px;overflow:auto;background:#000;padding:10px;border-radius:8px;font-size:12px;white-space:pre-wrap;word-break:break-word;"></pre>
    ${previewDoc ? `<div class="preview-frame-wrap" style="display:none;margin-top:8px;overflow:auto;background:#111;border-radius:8px;padding:8px;"><iframe class="preview-frame" style="width:100%;height:420px;border:none;border-radius:6px;background:#fff;"></iframe></div>` : ""}
  </div>`;

  container.innerHTML = html;
  const root = document.getElementById(boxId);
  const contentView = root.querySelector(".file-content-view");
  contentView.textContent = files[fileNames[0]] || "";

  root.querySelectorAll(".file-tab").forEach(tab => {
    tab.onclick = () => {
      root.querySelectorAll(".file-tab").forEach(t => t.style.background = "rgba(255,255,255,0.08)");
      tab.style.background = "rgba(255,255,255,0.25)";
      contentView.textContent = files[fileNames[Number(tab.dataset.idx)]] || "";
    };
  });

  if (previewDoc) {
    const frameWrap = root.querySelector(".preview-frame-wrap");
    const iframe = root.querySelector(".preview-frame");
    root.querySelectorAll(".preview-btn").forEach(btn => {
      btn.onclick = () => {
        frameWrap.style.display = "block";
        const view = btn.dataset.view;
        iframe.style.width = view === "mobile" ? "375px" : view === "tablet" ? "768px" : "100%";
        iframe.srcdoc = previewDoc;
      };
    });
  }
}

// =====================================================================
// WEBSITE BUILDER DIRECT API
// =====================================================================
async function buildWebsite(prompt, stack) {
  if (!prompt) return;
  const loaderMsg = addMessageToUI(`🔧 Generating ${stack || "HTML"} website: "${prompt}"...`, "bot");

  if (!csrfToken) await fetchCsrfToken();
  fetch(`${API_BASE}/api/website/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken || "" },
    credentials: "include",
    body: JSON.stringify({ prompt, stack: stack || "html" })
  })
  .then(res => res.json())
  .then(data => {
    if (data.ok) {
      renderProjectResult(loaderMsg, data, "website");
    } else {
      loaderMsg.innerHTML = `⚠️ Website generation failed: ${escapeHtml(data.error || "Unknown error")}`;
    }
    saveCurrentSession();
  })
  .catch(err => {
    loaderMsg.innerHTML = `⚠️ Network error: ${escapeHtml(err.message)}`;
  });
}

// =====================================================================
// PROJECT BUILDER DIRECT API
// =====================================================================
async function buildProject(prompt, tech) {
  if (!prompt) return;
  const loaderMsg = addMessageToUI(`⚙️ Building ${tech || "React"} project: "${prompt}"...`, "bot");

  if (!csrfToken) await fetchCsrfToken();
  fetch(`${API_BASE}/api/project/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken || "" },
    credentials: "include",
    body: JSON.stringify({ prompt, tech: tech || "React" })
  })
  .then(res => res.json())
  .then(data => {
    if (data.ok) {
      renderProjectResult(loaderMsg, data, "project");
    } else {
      loaderMsg.innerHTML = `⚠️ Project generation failed: ${escapeHtml(data.error || "Unknown error")}`;
    }
    saveCurrentSession();
  })
  .catch(err => {
    loaderMsg.innerHTML = `⚠️ Network error: ${escapeHtml(err.message)}`;
  });
}

// =====================================================================
// AI WEBSITE BUILDER WORKSPACE — SPLIT SCREEN MODE
// Left: Code Editor (HTML/CSS/JS tabs + Claude-style Copy buttons)
// Right: Live Preview (Run Preview button + Device toggle + Download ZIP)
// =====================================================================
let builderLastResult = { html: "", css: "", javascript: "" };
let currentPreviewDevice = "desktop";

const BUILDER_PLACEHOLDERS = {
  css: "/* ✨ No custom CSS was needed for this page — it already looks great with clean, minimal default styling. */",
  javascript: "// ⚡ No JavaScript was needed — this page is fully static."
};

function openWebsiteBuilder() {
  const el = document.getElementById("websiteBuilderPanel");
  if (el) el.classList.add("active");
  const sideMenu = document.getElementById("sideMenu");
  if (sideMenu && sideMenu.classList.contains("open")) toggleChatMenu();
  // Hide the Chat workspace behind the fullscreen builder (CSS rule:
  // #chatSection.builder-open > *:not(.builder-panel) { display:none }).
  // Nothing about the chat workspace itself is destroyed or reset —
  // closing the builder just removes this class and it reappears as-is.
  const chatSection = document.getElementById("chatSection");
  if (chatSection) chatSection.classList.add("builder-open");
}

function closeWebsiteBuilder() {
  const el = document.getElementById("websiteBuilderPanel");
  if (el) el.classList.remove("active");
  const chatSection = document.getElementById("chatSection");
  if (chatSection) chatSection.classList.remove("builder-open");
}

// Switch between HTML/CSS/JS code tabs
function switchBuilderCodeTab(tab) {
  document.querySelectorAll(".builder-code-tab").forEach(t => {
    t.classList.toggle("active", t.dataset.tab === tab);
  });
  document.querySelectorAll(".builder-code-pane").forEach(p => {
    p.classList.toggle("active", p.dataset.pane === tab);
  });
}

// Switch preview device (desktop/tablet/mobile)
function setPreviewDevice(device) {
  currentPreviewDevice = device;
  document.querySelectorAll(".preview-device-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.device === device);
  });
  const frame = document.getElementById("builderPreviewFrame");
  if (frame && frame.style.display !== "none") {
    frame.setAttribute("data-device", device);
  }
}

// Build the complete HTML document with CSS and JS inlined for iframe preview
function buildPreviewDocument(result) {
  let html = result.html || "";
  const css = result.css || "";
  const js = result.javascript || "";

  // If HTML doesn't have basic structure, wrap it
  if (!html.includes("<html") && !html.includes("<!DOCTYPE")) {
    html = `<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="UTF-8">\n<meta name="viewport" content="width=device-width, initial-scale=1.0">\n<title>Preview</title>\n</head>\n<body>\n${html}\n</body>\n</html>`;
  }

  // Inject CSS into <head> or before </head>
  if (css.trim()) {
    const styleTag = `<style>\n${css}\n</style>`;
    if (html.includes("</head>")) {
      html = html.replace("</head>", `${styleTag}\n</head>`);
    } else if (html.includes("<head>")) {
      html = html.replace("<head>", `<head>\n${styleTag}`);
    } else {
      html = html.replace("<html", `<head>\n${styleTag}\n</head>\n<html`);
    }
  }

  // Inject JS before </body> or before </html>
  if (js.trim()) {
    const scriptTag = `<script>\n${js}\n<\/script>`;
    if (html.includes("</body>")) {
      html = html.replace("</body>", `${scriptTag}\n</body>`);
    } else if (html.includes("</html>")) {
      html = html.replace("</html>", `${scriptTag}\n</html>`);
    } else {
      html += `\n${scriptTag}`;
    }
  }

  return html;
}

// Run the preview — called when user clicks "Run Preview" button
function runBuilderPreview() {
  const frame = document.getElementById("builderPreviewFrame");
  const placeholder = document.getElementById("builderPreviewPlaceholder");

  if (!frame || !placeholder) return;

  const previewDoc = buildPreviewDocument(builderLastResult);

  // Hide placeholder, show iframe with animation
  placeholder.style.display = "none";
  frame.style.display = "block";
  frame.setAttribute("data-device", currentPreviewDevice);
  frame.srcdoc = previewDoc;
}

// Download generated code as ZIP file
async function downloadBuilderZip() {
  const html = builderLastResult.html || "";
  const css = builderLastResult.css || "";
  const js = builderLastResult.javascript || "";

  if (!html && !css && !js) {
    alert("No code generated yet. Please generate a website first.");
    return;
  }

  try {
    // Try to use JSZip if available, otherwise fallback to simple download
    if (typeof JSZip !== 'undefined') {
      const zip = new JSZip();
      if (html) zip.file("index.html", html);
      if (css) zip.file("style.css", css);
      if (js) zip.file("script.js", js);

      const content = await zip.generateAsync({ type: "blob" });
      const url = URL.createObjectURL(content);
      const a = document.createElement("a");
      a.href = url;
      a.download = `syra-website-${Date.now()}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } else {
      // Fallback: download as individual files or combined text
      downloadBuilderFilesIndividually();
    }
  } catch (err) {
    console.error("ZIP download failed:", err);
    downloadBuilderFilesIndividually();
  }
}

// Fallback: download files individually
function downloadBuilderFilesIndividually() {
  const files = [
    { name: "index.html", content: builderLastResult.html },
    { name: "style.css", content: builderLastResult.css },
    { name: "script.js", content: builderLastResult.javascript }
  ];

  files.forEach(file => {
    if (!file.content) return;
    const blob = new Blob([file.content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  });
}

function renderBuilderResult(result) {
  builderLastResult = result;
  const fieldMap = { html: "builderCodeHtml", css: "builderCodeCss", javascript: "builderCodeJavascript" };

  Object.keys(fieldMap).forEach(key => {
    const el = document.getElementById(fieldMap[key]);
    if (!el) return;
    const value = (result[key] || "").trim();
    if (!value && BUILDER_PLACEHOLDERS[key]) {
      el.textContent = BUILDER_PLACEHOLDERS[key];
      el.classList.add("builder-placeholder");
    } else {
      el.textContent = value || "// Nothing generated for this file.";
      el.classList.remove("builder-placeholder");
    }
  });

  // Show the split workspace
  const workspace = document.getElementById("builderSplitWorkspace");
  if (workspace) workspace.style.display = "grid";

  // Show download ZIP button
  const zipBtn = document.getElementById("builderDownloadZipBtn");
  if (zipBtn) zipBtn.style.display = "inline-flex";

  // Reset preview to placeholder state
  const frame = document.getElementById("builderPreviewFrame");
  const placeholder = document.getElementById("builderPreviewPlaceholder");
  if (frame) {
    frame.style.display = "none";
    frame.srcdoc = "";
  }
  if (placeholder) placeholder.style.display = "flex";

  // Default to HTML tab
  switchBuilderCodeTab("html");
}

async function generateWebsiteBuilder() {
  const input = document.getElementById("builderPromptInput");
  const statusEl = document.getElementById("builderStatus");
  const btn = document.getElementById("builderGenerateBtn");
  const prompt = (input && input.value || "").trim();

  if (!prompt) {
    if (statusEl) {
      statusEl.style.display = "block";
      statusEl.textContent = "⚠️ Please describe the website you want first.";
    }
    return;
  }

  if (btn) { btn.disabled = true; btn.textContent = "⏳ Generating..."; }
  if (statusEl) {
    statusEl.style.display = "block";
    statusEl.textContent = "🔧 SYRA is building your website...";
  }

  try {
    const { ok, data } = await apiFetch(`${API_BASE}/api/website-builder/generate`, {
      method: "POST",
      body: { prompt }
    });

    if (ok && data && data.ok) {
      renderBuilderResult({ html: data.html, css: data.css, javascript: data.javascript });
      if (statusEl) statusEl.style.display = "none";
    } else if (statusEl) {
      statusEl.style.display = "block";
      statusEl.textContent = `⚠️ ${(data && data.message) || "Website generation failed."}`;
    }
  } catch (err) {
    if (statusEl) {
      statusEl.style.display = "block";
      statusEl.textContent = `⚠️ Network error: ${err.message}`;
    }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "✨ Generate"; }
  }
}

function copyBuilderCode(kind) {
  const value = builderLastResult[kind] || "";
  if (!value) return;

  const btn = document.querySelector(`.builder-code-pane[data-pane="${kind}"] .code-copy-btn`);

  const showFeedback = () => {
    if (!btn) return;
    btn.classList.add("copied");
    btn.title = "Copied!";
    setTimeout(() => { 
      btn.classList.remove("copied");
      btn.title = "Copy code";
    }, 1500);
  };

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(value).then(showFeedback).catch(() => fallbackCopy(value, showFeedback));
  } else {
    fallbackCopy(value, showFeedback);
  }
}

function fallbackCopy(value, onDone) {
  const ta = document.createElement("textarea");
  ta.value = value;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand("copy"); } catch (e) { /* no-op */ }
  document.body.removeChild(ta);
  if (onDone) onDone();
}

// =====================================================================
// CHAT MODE SWITCHER — GPT-style mode selector in chat input bar
// =====================================================================
function setChatMode(mode) {
  activeChatMode = mode;

  // Update UI
  document.querySelectorAll(".mode-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.mode === mode);
  });

  // Show/hide mode indicator pill
  const pill = document.getElementById("modeIndicatorPill");
  const modeNames = {
    general: "Chat",
    code: "Code",
    website: "Web Builder",
    image: "Image",
    project: "Project",
    agri: "Agro"
  };
  const modeIcons = {
    general: "fa-comments",
    code: "fa-code",
    website: "fa-globe",
    image: "fa-image",
    project: "fa-folder-tree",
    agri: "fa-seedling"
  };

  if (pill) {
    if (mode !== "general") {
      pill.style.display = "inline-flex";
      pill.innerHTML = `<i class="fa-solid ${modeIcons[mode] || 'fa-bolt'}"></i> ${modeNames[mode] || mode} Mode`;
    } else {
      pill.style.display = "none";
    }
  }

  // Update placeholder based on mode
  const input = document.getElementById("messageInput");
  if (input) {
    const placeholders = {
      general: "Ask SYRA AI anything...",
      code: "Describe the code you want to generate...",
      website: "Describe the website you want to build...",
      image: "Describe the image you want to create...",
      project: "Describe the project architecture you need...",
      agri: "Ask about crops, fertilizers, or farming..."
    };
    input.placeholder = placeholders[mode] || placeholders.general;
  }

  // If switching to website/image/project mode, show relevant UI hints
  if (mode === "website") {
    addMessageToUI("🌐 Website Builder mode activated. Describe the website you want and I'll generate HTML, CSS, and JavaScript with a live preview.", "bot");
  } else if (mode === "image") {
    addMessageToUI("🎨 Image Generation mode activated. Describe the artwork you want and I'll create it for you.", "bot");
  } else if (mode === "project") {
    addMessageToUI("📂 Project Builder mode activated. Describe your software architecture and I'll generate the complete project structure.", "bot");
  }
}
// =====================================================================
// IMAGE GENERATION DIRECT API
// =====================================================================
async function generateImage(prompt) {
  if (!prompt) return;
  const loaderMsg = addMessageToUI(`🎨 Generating image: "${prompt}"...`, "bot");

  if (!csrfToken) await fetchCsrfToken();
  fetch(`${API_BASE}/api/image/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken || "" },
    credentials: "include",
    body: JSON.stringify({ prompt })
  })
  .then(res => res.json())
  .then(data => {
    if (data.ok && data.url) {
      loaderMsg.innerHTML = renderImageResponse(data.url, data.prompt || prompt);
    } else {
      loaderMsg.innerHTML = `⚠️ Image generation failed: ${data.error}`;
    }
    saveCurrentSession();
  })
  .catch(err => {
    loaderMsg.innerHTML = `⚠️ Network error: ${err.message}`;
  });
}

// =====================================================================
// METEOROLOGY & PRICING
// =====================================================================
function getLiveWeather() {
  if (!navigator.geolocation) {
    setWeatherUI("Location blocked", "");
    return;
  }
  navigator.geolocation.getCurrentPosition(
    pos => {
      const lat = pos.coords.latitude;
      const lon = pos.coords.longitude;
      fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true`)
        .then(res => res.json())
        .then(data => {
          const w = data.current_weather;
          if (w) {
            setWeatherUI(`${Math.round(w.temperature)}°C`, "Clear Climate Conditions");
          } else {
            setWeatherUI("Weather Unavailable", "");
          }
        })
        .catch(() => setWeatherUI("Station Offline", ""));
    },
    () => setWeatherUI("Location denied", "")
  );
}

function setWeatherUI(temp, cond) {
  const el = document.getElementById("weatherCard");
  if (el) el.innerHTML = `<b>${temp}</b>${cond ? " • " + cond : ""}`;
}

// =====================================================================
// SUPPORT MODAL
// =====================================================================
function openSupport() {
  const el = document.getElementById("supportPanel");
  if (el) el.classList.add("active");
}
function closeSupport() {
  const el = document.getElementById("supportPanel");
  if (el) el.classList.remove("active");
}
function showSupport(type) {
  const box = document.getElementById("supportContent");
  if (!box) return;
  if (type === 'faq') {
    box.innerHTML = `
      <h3>Frequently Asked Questions</h3>
      <p><b>Q: How do I load datasets?</b><br>A: Open the "+" menu, click "Files", select any spreadsheet/text, and SYRA will index the content for Q&A.</p>
      <p><b>Q: Is my data secure?</b><br>A: All connections are encrypted and data persists locally on your device.</p>
      <p><b>Q: How do I use voice chat?</b><br>A: Click the microphone button, speak, then click stop. SYRA will transcribe and respond.</p>
      <p><b>Q: Can I generate images?</b><br>A: Yes! Just say "generate image of..." or use the + menu to switch to image mode.</p>
    `;
  } else if (type === 'contact') {
    box.innerHTML = `
      <h3>Contact Support</h3>
      <p>📧 Email: <a href="mailto:smartfarming04ai@gmail.com">smartfarming04ai@gmail.com</a></p>
      <p>We typically respond within 24 hours.</p>
    `;
  } else {
    box.innerHTML = `<p>Core system integration operational. Configuration is saved automatically.</p>`;
  }
}
function reportBug() {
  window.location.href = "mailto:smartfarming04ai@gmail.com?subject=Platform Bug Report";
}
function contactSupport() {
  window.location.href = "mailto:smartfarming04ai@gmail.com?subject=Engineering Support Assistance Request";
}
function featureRequest() {
  window.location.href = "mailto:smartfarming04ai@gmail.com?subject=Platform Feature Request";
}

// =====================================================================
// SETTINGS
// =====================================================================
function openSettings() {
  const el = document.getElementById("settingsPanel");
  if (el) el.classList.add("active");
}
function closeSettings() {
  const el = document.getElementById("settingsPanel");
  if (el) el.classList.remove("active");
}
function openSetting(type) {
  const detail = document.getElementById("settingDetail");
  const title = document.getElementById("detailTitle");
  const content = document.getElementById("detailContent");
  if (!detail || !title || !content) return;

  title.textContent = type.toUpperCase();
  detail.classList.add("active");

  if (type === 'profile') {
    content.innerHTML = `<p class="thinking-span">Loading profile...</p>`;
    loadProfilePanel(content);
  } else if (type === 'appearance') {
    const savedTheme = localStorage.getItem("syra_theme") || "dark";
    content.innerHTML = `
      <div class="setting-toggle-row">
        <span>🌙 Dark Mode</span>
        <input type="checkbox" id="darkModeToggle" ${savedTheme !== 'light' ? 'checked' : ''}>
      </div>
      <p style="margin-top:14px;">Select Aesthetic Palette:</p>
      <button class="btn outline" style="margin-top:10px;width:100%" onclick="setTheme('dark')">Aura Eclipse Theme</button>
      <button class="btn outline" style="margin-top:10px;width:100%" onclick="setTheme('light')">Vivid Solstice Theme</button>
    `;
    const dmToggle = document.getElementById("darkModeToggle");
    if (dmToggle) dmToggle.onchange = () => setTheme(dmToggle.checked ? 'dark' : 'light');
  } else if (type === 'language') {
    content.innerHTML = `
        <div style="text-align:center;padding:20px;">
            <i class="fas fa-language" style="font-size:50px;color:var(--accent);margin-bottom:20px;"></i>

            <h3>Language Selection</h3>

            <p style="margin-top:15px;font-size:16px;">
                🚧 Coming Soon
            </p>

            <p style="margin-top:10px;color:var(--text-secondary);line-height:1.6;">
                Full multilingual interface support will be available in a future update.
            </p>
        </div>
    `;
} else if (type === 'export') {
    content.innerHTML = `
      <p>Download all of your saved conversations as a JSON file.</p>
      <button class="save-btn" style="margin-top:14px;" onclick="exportChats()">⬇️ Export Chats</button>
    `;
  } else if (type === 'delete-account') {
    content.innerHTML = `
      <p>This permanently deletes your SYRA account, profile, and all saved chat history. This action cannot be undone.</p>
      <button class="danger-btn" style="margin-top:14px;" onclick="deleteAccount()">Delete My Account</button>
    `;
  } else if (type === 'privacy-policy') {
    content.innerHTML = `
      <div class="setting-static-text">
        <h4>Data We Store</h4>
        <p>Your chats, profile info, and preferences are stored securely to power your SYRA experience.</p>
        <h4>How We Use It</h4>
        <p>Your data is used only to provide and improve the SYRA AI service, never sold to third parties.</p>
        <h4>Your Controls</h4>
        <p>You can export or permanently delete your chat history and account at any time from Settings.</p>
      </div>
    `;
  } else if (type === 'terms') {
    content.innerHTML = `
      <div class="setting-static-text">
        <h4>Acceptance of Terms</h4>
        <p>By using SYRA AI, you agree to use the platform responsibly and lawfully.</p>
        <h4>AI-Generated Content</h4>
        <p>Responses are AI-generated and may occasionally be inaccurate. Use good judgment before relying on them.</p>
        <h4>Account Responsibility</h4>
        <p>You're responsible for keeping your login credentials secure.</p>
      </div>
    `;
  } else if (type === 'about') {
    content.innerHTML = `
      <div class="setting-static-text">
        <h4>SYRA AI</h4>
        <p>SYRA is an advanced AI assistant created by Surya under the KRISH project — built for chat, coding, agriculture insights, website generation, and creative image generation.</p>
      </div>
    `;
  } else if (type === 'models') {
    content.innerHTML = `
      <p>Select Active AI Model:</p>
      <select class="setting-input" id="modelSelect" onchange="activeModel = this.value">
        <option value="default" ${activeModel === "default" ? "selected" : ""}>SYRA Quick (Default)</option>
        <option value="gpt-4" ${activeModel === "gpt-4" ? "selected" : ""}>GPT-4 Omni</option>
        <option value="claude" ${activeModel === "claude" ? "selected" : ""}>Claude 3.5 Sonnet</option>
        <option value="deepseek" ${activeModel === "deepseek" ? "selected" : ""}>DeepSeek R1</option>
        <option value="gemini" ${activeModel === "gemini" ? "selected" : ""}>Gemini Pro</option>
        <option value="mistral" ${activeModel === "mistral" ? "selected" : ""}>Mistral 7B</option>
        <option value="llama" ${activeModel === "llama" ? "selected" : ""}>LLaMA 3 70B</option>
      </select>
    `;
  } else if (type === 'chat') {
    content.innerHTML = `
      <p>Select Chat Mode:</p>
      <select class="setting-input" onchange="activeChatMode = this.value">
        <option value="general" ${activeChatMode === "general" ? "selected" : ""}>General Assistant</option>
        <option value="code" ${activeChatMode === "code" ? "selected" : ""}>Code Expert</option>
        <option value="agri" ${activeChatMode === "agri" ? "selected" : ""}>Agriculture Consultant</option>
        <option value="website" ${activeChatMode === "website" ? "selected" : ""}>Website Builder</option>
        <option value="project" ${activeChatMode === "project" ? "selected" : ""}>Project Builder</option>
      </select>
    `;
  } else {
    content.innerHTML = `<p>Core system integration operational. Configuration is saved automatically.</p>`;
  }
}

function closeSettingDetail() {
  const el = document.getElementById("settingDetail");
  if (el) el.classList.remove("active");
}

function setTheme(t) {
  document.documentElement.setAttribute("data-theme", t);
  localStorage.setItem("syra_theme", t);
  apiFetch(`${API_BASE}/api/settings`, {
    method: "PATCH",
    body: { session_id: currentSessionIdParam(), theme: t, dark_mode: t !== "light" }
  }).catch(() => {});
}

function triggerUpload() {
  const el = document.getElementById("avatarInput");
  if (el) el.click();
}

// =====================================================================
// PROFILE PANEL (Settings > Profile & Account)
// =====================================================================
async function loadProfilePanel(content) {
  // Source of truth for "am I logged in" is the SAME Flask session check
  // the rest of the app already relies on (/api/check_session) — this is
  // the existing Google Login / Email OTP session, nothing new. We never
  // gate the profile panel on a fresh independent check; if the session
  // says logged in, we render the profile using that, and only use
  // /api/profile to enrich it with extra fields (picture, joined date,
  // provider) — never to decide whether to show the login prompt.
  let sessionUser = null;
  try {
    const { data } = await apiFetch(`${API_BASE}/api/check_session`);
    if (data && data.logged_in) sessionUser = data.user || {};
  } catch (e) { /* network error — treated as unknown below */ }

  if (!sessionUser) {
    content.innerHTML = `<p>Log in to view and edit your profile.</p>
      <button class="btn primary" style="margin-top:10px;width:100%" onclick="closeSettingDetail(); openLogin();">Login</button>`;
    return;
  }

  // Already confirmed logged in via the existing session above. Start
  // from what the session already knows, then layer in richer fields
  // from /api/profile if available — but never fall back to the login
  // prompt just because that enrichment call had an issue.
  let profile = {
    name: sessionUser.name || "User",
    email: sessionUser.email || "",
    phone: sessionUser.phone || "",
    login_type: sessionUser.email ? "email" : (sessionUser.phone ? "phone" : ""),
    picture: null,
    joined_at: null
  };

  try {
    const { data } = await apiFetch(`${API_BASE}/api/profile`);
    if (data && data.ok && data.profile) {
      profile = { ...profile, ...data.profile };
    }
  } catch (e) { /* keep the session-derived profile above */ }

  const initial = (profile.name || "U").trim().charAt(0).toUpperCase();
  const joined = profile.joined_at ? new Date(profile.joined_at).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }) : "—";
  const providerLabel = { google: "Google", email: "Email OTP", phone: "Phone" }[profile.login_type] || profile.login_type || "—";

  content.innerHTML = `
    <div class="profile-edit-avatar-row">
      <div class="avatar" id="profileFormAvatar">
        ${profile.picture ? `<img src="${escapeHtml(profile.picture)}" alt="Profile photo">` : `<span>${escapeHtml(initial)}</span>`}
      </div>
      <div>
        <input type="file" id="profilePictureInput" accept="image/*" hidden>
        <button type="button" class="upload-avatar-btn" onclick="document.getElementById('profilePictureInput').click()">Change Photo</button>
      </div>
    </div>

    <label style="font-size:12px;color:var(--muted)">Name</label>
    <input class="setting-input" id="profileNameInput" type="text" value="${escapeHtml(profile.name || '')}">

    <p class="profile-meta-readonly">📧 Email: <b>${escapeHtml(profile.email || profile.phone || '—')}</b></p>
    <p class="profile-meta-readonly">🔐 Login Provider: <b>${escapeHtml(providerLabel)}</b></p>
    <p class="profile-meta-readonly">📅 Joined: <b>${escapeHtml(joined)}</b></p>

    <button class="save-btn" onclick="saveProfile()">💾 Save Changes</button>
    <button class="danger-btn" style="margin-top:10px;background:transparent;border:1px solid var(--border);color:var(--muted)" onclick="logout()">🚪 Logout</button>
  `;

  const picInput = document.getElementById("profilePictureInput");
  if (picInput) picInput.onchange = () => uploadProfilePicture(picInput);
}

async function saveProfile() {
  const nameInput = document.getElementById("profileNameInput");
  if (!nameInput) return;
  const name = nameInput.value.trim();
  if (!name) { alert("Name cannot be empty."); return; }

  const { data } = await apiFetch(`${API_BASE}/api/profile`, { method: "PATCH", body: { name } });
  if (data && data.ok) {
    const nameEl = document.getElementById("profileName");
    const chatNameEl = document.getElementById("chatProfileName");
    const menuNameEl = document.getElementById("menuName");
    if (nameEl) nameEl.textContent = name;
    if (chatNameEl) chatNameEl.textContent = name;
    if (menuNameEl) menuNameEl.textContent = name;

    const cached = JSON.parse(localStorage.getItem(CACHED_USER_KEY) || "null");
    if (cached) { cached.name = name; localStorage.setItem(CACHED_USER_KEY, JSON.stringify(cached)); }

    alert("Profile updated.");
  } else {
    alert((data && data.message) || "Failed to update profile.");
  }
}

async function uploadProfilePicture(input) {
  const file = input.files[0];
  if (!file) return;
  const formData = new FormData();
  formData.append("file", file);
  try {
    const data = await uploadWithProgress(`${API_BASE}/api/profile/picture`, formData);
    if (data && data.ok && data.picture) {
      const avatarBox = document.getElementById("profileFormAvatar");
      if (avatarBox) avatarBox.innerHTML = `<img src="${data.picture}" alt="Profile photo">`;
      const mainAvatarImg = document.getElementById("avatarImg");
      if (mainAvatarImg) { mainAvatarImg.src = data.picture; mainAvatarImg.style.display = "block"; }
    } else {
      alert((data && data.message) || "Failed to upload photo.");
    }
  } catch (e) {
    alert("Upload failed: " + e.message);
  }
}

// =====================================================================
// LANGUAGE PANEL (Settings > Language Selection) — persisted server-side
// =====================================================================
const SUPPORTED_LANGUAGES = [
  { code: "en", label: "English" },
  { code: "ta", label: "தமிழ் (Tamil)" },
  { code: "hi", label: "हिन्दी (Hindi)" },
  { code: "ta_tanglish", label: "Tanglish" },
];

async function loadLanguagePanel(content) {
  let language = "en";
  try {
    const { data } = await apiFetch(`${API_BASE}/api/settings?session_id=${encodeURIComponent(currentSessionIdParam())}`);
    if (data && data.ok) language = data.settings.language || "en";
  } catch (e) { /* default to English */ }

  content.innerHTML = `
    <p>Select your preferred language:</p>
    <select class="setting-input" id="languageSelect">
      ${SUPPORTED_LANGUAGES.map(l => `<option value="${l.code}" ${l.code === language ? "selected" : ""}>${l.label}</option>`).join("")}
    </select>
  `;
  const select = document.getElementById("languageSelect");
  if (select) select.onchange = () => saveLanguage(select.value);
}

async function saveLanguage(code) {
  await apiFetch(`${API_BASE}/api/settings`, {
    method: "PATCH",
    body: { session_id: currentSessionIdParam(), language: code }
  });
  localStorage.setItem("syra_language", code);
}

// Loads dark mode / theme preference from the server on startup (falls
// back to whatever's already in localStorage if the request fails).
async function loadServerSettings() {
  try {
    const { data } = await apiFetch(`${API_BASE}/api/settings?session_id=${encodeURIComponent(currentSessionIdParam())}`);
    if (data && data.ok && data.settings && data.settings.theme) {
      document.documentElement.setAttribute("data-theme", data.settings.theme);
      localStorage.setItem("syra_theme", data.settings.theme);
    }
  } catch (e) { /* keep local theme */ }
}

// =====================================================================
// EXPORT CHATS (Settings > Export Chats)
// =====================================================================
async function exportChats() {
  try {
    const res = await fetch(`${API_BASE}/api/chats/export?session_id=${encodeURIComponent(currentSessionIdParam())}`, {
      credentials: "include"
    });
    if (!res.ok) throw new Error("Export failed");
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "syra_chat_export.json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (e) {
    alert("Failed to export chats: " + e.message);
  }
}

// =====================================================================
// DELETE ACCOUNT (Settings > Delete Account)
// =====================================================================
async function deleteAccount() {
  if (!confirm("This will permanently delete your account and all chat history. Continue?")) return;
  if (!confirm("Are you absolutely sure? This cannot be undone.")) return;

  const { data } = await apiFetch(`${API_BASE}/api/account/delete`, { method: "POST" });
  if (data && data.ok) {
    localStorage.removeItem(CACHED_USER_KEY);
    localStorage.removeItem("syra_chats");
    alert("Your account has been deleted.");
    window.location.reload();
  } else {
    alert((data && data.message) || "Failed to delete account.");
  }
}
