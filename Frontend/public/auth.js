/* =====================================================================
   SYRA AI — AUTH.JS
   Standalone authentication module (Login / Register / OTP / Google /
   Phone / Logout / Session). Fully self-contained — does not touch
   chat, sidebar, workspace, or any other application logic in script.js.

   Backend contract (Flask — endpoint names are fixed, do not change):
     POST /api/send-otp      { mode, method, email|phone, name }
     POST /api/verify-otp    { mode, method, email|phone, otp, name }
     POST /api/logout        {}
     GET  /api/check_session -> { logged_in, user }

   Google Sign-In and native Phone Auth are wired as Firebase
   placeholders below — they activate automatically once a Firebase
   config + SDK are added to index.html.
   ===================================================================== */

(function () {
  "use strict";

  // Same backend the application half of the app talks to (script.js).
  // Duplicated as a plain constant (not shared logic) so this file stays
  // fully self-contained and can be dropped into any page unmodified.
  const API_BASE = "https://syra-backend.onrender.com";
  const CACHED_USER_KEY = "syra_user";
  const REMEMBER_KEY = "syra_remember_me";

  /* -------------------------------------------------------------------
     STATE
  ------------------------------------------------------------------- */
  const AUTH = {
    mode: "login",          // "login" | "register"
    method: null,           // "email" | "phone"
    otpTarget: null,        // email address or full phone number in-flight
    otpLength: 6,
    resendSeconds: 30,
    resendTimer: null,
    submitting: false
  };

  let csrfToken = null;

  // Firebase Phone Auth state — kept separate from AUTH so it never
  // interferes with the existing email OTP flow.
  let recaptchaVerifier = null;
  let phoneConfirmationResult = null;

  /* -------------------------------------------------------------------
     DOM HELPERS
  ------------------------------------------------------------------- */
  const $ = (id) => document.getElementById(id);

  function showStep(stepId) {
    document.querySelectorAll(".auth-step").forEach((el) => el.classList.remove("active"));
    const target = $(stepId);
    if (target) target.classList.add("active");
    hideError();
  }

  function showError(message) {
    const banner = $("authErrorBanner");
    if (!banner) return;
    banner.textContent = message;
    banner.classList.add("show");
  }

  function hideError() {
    const banner = $("authErrorBanner");
    if (!banner) return;
    banner.classList.remove("show");
    banner.textContent = "";
  }

  function setLoading(buttonEl, isLoading, labelWhenIdle) {
    if (!buttonEl) return;
    buttonEl.disabled = isLoading;
    buttonEl.innerHTML = isLoading
      ? `<span class="auth-btn-label"><span class="auth-spinner"></span> Please wait…</span>`
      : `<span class="auth-btn-label">${labelWhenIdle}</span>`;
  }

  function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }

  function isValidPhone(phone) {
    return /^[0-9]{7,15}$/.test(phone);
  }

  /* -------------------------------------------------------------------
     BACKEND API CLIENT (CSRF-aware, scoped to auth requests only)
  ------------------------------------------------------------------- */
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

  async function authPost(path, body) {
    if (!csrfToken) await fetchCsrfToken();
    const res = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken || "" },
      credentials: "include",
      body: JSON.stringify(body || {})
    });
    let data = {};
    try { data = await res.json(); } catch (e) { /* non-JSON response */ }
    return { ok: res.ok, status: res.status, data };
  }

  async function authGet(path) {
    const res = await fetch(`${API_BASE}${path}`, { credentials: "include" });
    let data = {};
    try { data = await res.json(); } catch (e) { /* non-JSON response */ }
    return { ok: res.ok, status: res.status, data };
  }

  /* -------------------------------------------------------------------
     REMEMBER ME
     No checkbox exists in the current markup, so this defaults to on
     and simply controls whether checkSession() may fall back to the
     locally cached profile when the network request fails.
  ------------------------------------------------------------------- */
  function rememberMe(shouldRemember = true) {
    try {
      localStorage.setItem(REMEMBER_KEY, shouldRemember ? "1" : "0");
    } catch (e) { /* storage unavailable */ }
    return shouldRemember;
  }

  function isRememberEnabled() {
    try {
      return localStorage.getItem(REMEMBER_KEY) !== "0";
    } catch (e) {
      return true;
    }
  }

  function cacheUser(user) {
    try {
      localStorage.setItem(CACHED_USER_KEY, JSON.stringify(user));
    } catch (e) { /* storage unavailable */ }
  }

  function getCachedUser() {
    try {
      return JSON.parse(localStorage.getItem(CACHED_USER_KEY) || "null");
    } catch (e) {
      return null;
    }
  }

  function clearCachedUser() {
    try {
      localStorage.removeItem(CACHED_USER_KEY);
    } catch (e) { /* storage unavailable */ }
  }

  /* -------------------------------------------------------------------
     MODAL OPEN / CLOSE
  ------------------------------------------------------------------- */
  function openLogin() {
    AUTH.mode = "login";
    resetAuthUI();
    const overlay = $("loginModal");
    if (overlay) overlay.classList.add("open");
    document.body.style.overflow = "hidden";
  }

  function closeLogin() {
    const overlay = $("loginModal");
    if (overlay) overlay.classList.remove("open");
    document.body.style.overflow = "";
    clearInterval(AUTH.resendTimer);
  }

  function resetAuthUI() {
    hideError();
    AUTH.method = null;
    AUTH.otpTarget = null;
    phoneConfirmationResult = null;
    updateAuthModeUI();
    showStep("authStepMethods");
    const emailInput = $("emailInput");
    const nameInput = $("nameInput");
    const phoneInput = $("phoneInput");
    if (emailInput) emailInput.value = "";
    if (nameInput) nameInput.value = "";
    if (phoneInput) phoneInput.value = "";
    clearOtpBoxes();
  }

  function toggleAuthMode() {
    AUTH.mode = AUTH.mode === "login" ? "register" : "login";
    updateAuthModeUI();
  }

  function updateAuthModeUI() {
    const isRegister = AUTH.mode === "register";
    const title = $("authTitle");
    const subtitle = $("authSubtitle");
    const nameInput = $("nameInput");
    const switchText = $("authSwitchText");
    const switchBtn = $("authSwitchBtn");

    if (title) title.textContent = isRegister ? "Create your account" : "Welcome back";
    if (subtitle) subtitle.textContent = isRegister
      ? "AI That Builds Everything — let's get you set up"
      : "Log in to continue to SYRA AI";
    if (nameInput) nameInput.style.display = isRegister ? "block" : "none";
    if (switchText) switchText.textContent = isRegister ? "Already have an account?" : "New to SYRA AI?";
    if (switchBtn) switchBtn.textContent = isRegister ? "Login" : "Register here";
  }

  /* -------------------------------------------------------------------
     METHOD SELECTION
  ------------------------------------------------------------------- */
  function showEmailLogin() {
    AUTH.method = "email";
    showStep("authStepEmail");
    const emailInput = $("emailInput");
    if (emailInput) emailInput.focus();
  }

  function showPhoneLogin() {
    showError(
        "📱 Phone Login is coming soon. Please use Google Login or Email OTP Login."
    );
}

  function backToMethods() {
    showStep("authStepMethods");
  }

  function backToEntry() {
    if (AUTH.method === "phone") {
      showStep("authStepPhone");
    } else {
      showStep("authStepEmail");
    }
    clearInterval(AUTH.resendTimer);
  }

  /* -------------------------------------------------------------------
     GOOGLE LOGIN (Firebase placeholder — wires up once Firebase config
     and SDK script tags are added to index.html)
  ------------------------------------------------------------------- */
  async function googleLogin() {
    hideError();
    if (typeof firebase === "undefined" || !window.firebaseAuth || !window.googleProvider) {
      showError("Google Sign-In isn't configured yet. Add your Firebase config to enable this.");
      return;
    }

    const btn = $("btnGoogleLogin");
    const idleLabel = "Continue with Google";
    setLoading(btn, true, idleLabel);

    try {
      const result = await window.firebaseAuth.signInWithPopup(window.googleProvider);
      const idToken = await result.user.getIdToken();

      const { ok, data } = await authPost("/api/google-login", { idToken });
      setLoading(btn, false, idleLabel);

      if (!ok || data.ok === false) {
        showError((data && (data.message || data.error)) || "Google Sign-In failed. Please try again.");
        return;
      }

      if (data.csrf_token) csrfToken = data.csrf_token;
      rememberMe(true);
      await onAuthSuccess(data.user);
    } catch (err) {
      setLoading(btn, false, idleLabel);
      if (err && err.code === "auth/popup-closed-by-user") return;
      showError((err && err.message) || "Google Sign-In failed. Please try again.");
    }
  }

  /* -------------------------------------------------------------------
     PHONE LOGIN — Firebase Phone Authentication (invisible reCAPTCHA)
     Container already exists in the markup as #recaptchaContainer.
  ------------------------------------------------------------------- */
  function isFirebasePhoneAuthAvailable() {
    return typeof firebase !== "undefined" && !!window.firebaseAuth;
  }

  function getRecaptchaVerifier() {

    if (recaptchaVerifier) {
        return recaptchaVerifier;
    }

    recaptchaVerifier = new firebase.auth.RecaptchaVerifier(
        "recaptchaContainer",
        {
            size: "invisible",
            callback: function () {
                console.log("reCAPTCHA verified");
            },
            "expired-callback": function () {
                console.log("reCAPTCHA expired");
            }
        }
    );

    recaptchaVerifier.render();

    return recaptchaVerifier;
}

  // Kept as a public alias for any existing markup that references
  // phoneLogin() directly; the real work happens in sendOTP()/verifyOTP().
  function phoneLogin() {
    sendOTP();
  }

  /* -------------------------------------------------------------------
     SEND OTP (email or phone) — POST /api/send-otp
  ------------------------------------------------------------------- */
  async function sendOTP() {
    hideError();

    let payload;
    if (AUTH.method === "phone") {
      const countryCode = $("countryCode") ? $("countryCode").value : "+91";
      const phone = ($("phoneInput") ? $("phoneInput").value : "").trim();
      if (!isValidPhone(phone)) {
        showError("Enter a valid phone number.");
        return;
      }
      AUTH.otpTarget = countryCode + phone;

      if (isFirebasePhoneAuthAvailable()) {
        // Real Firebase Phone Authentication path — SMS is sent by
        // Firebase directly, not by the backend /api/send-otp route.
        await sendFirebasePhoneOTP();
        return;
      }

      payload = { mode: AUTH.mode, method: "phone", phone: AUTH.otpTarget };
    } else {
      const name = ($("nameInput") ? $("nameInput").value : "").trim();
      const email = ($("emailInput") ? $("emailInput").value : "").trim();

      if (AUTH.mode === "register" && !name) {
        showError("Please enter your full name.");
        return;
      }
      if (!isValidEmail(email)) {
        showError("Enter a valid email address.");
        return;
      }
      AUTH.otpTarget = email;
      payload = { mode: AUTH.mode, method: "email", email, name };
    }

    const btn = $("btnSendOTP");
    const idleLabel = "Send OTP";
    setLoading(btn, true, idleLabel);
    AUTH.submitting = true;

    try {
      const { ok, data } = await authPost("/api/send-otp", payload);
      setLoading(btn, false, idleLabel);
      AUTH.submitting = false;
      if (!ok || data.ok === false) {
        showError((data && (data.message || data.error)) || "Could not send OTP. Please try again.");
        return;
      }
      showStep("authStepOtp");
      const otpMetaTarget = $("otpTargetLabel");
      if (otpMetaTarget) otpMetaTarget.textContent = AUTH.otpTarget;
      clearOtpBoxes();
      focusFirstOtpBox();
      startResendTimer();
    } catch (e) {
      setLoading(btn, false, idleLabel);
      AUTH.submitting = false;
      showError("Network error while sending OTP. Please try again.");
    }
  }

  /* -------------------------------------------------------------------
     SEND OTP VIA FIREBASE (phone only) — invisible reCAPTCHA +
     signInWithPhoneNumber. Lands the user on the same OTP screen used
     by the email flow; verifyOTP() below routes phone codes to Firebase
     instead of the backend.
  ------------------------------------------------------------------- */
  async function sendFirebasePhoneOTP() {
    const btn = $("btnSendOTP");
    const idleLabel = "Send OTP";
    setLoading(btn, true, idleLabel);
    AUTH.submitting = true;

    try {
        const verifier = getRecaptchaVerifier();
        phoneConfirmationResult = await window.firebaseAuth.signInWithPhoneNumber(
            AUTH.otpTarget,
            verifier
        );

        window._otpConfirmation = phoneConfirmationResult;

        setLoading(btn, false, idleLabel);
        AUTH.submitting = false;

        showStep("authStepOtp");

        const otpMetaTarget = $("otpTargetLabel");
        if (otpMetaTarget) otpMetaTarget.textContent = AUTH.otpTarget;

        clearOtpBoxes();
        focusFirstOtpBox();
        startResendTimer();

    } catch (err) {

        console.error("PHONE AUTH ERROR:", err);
        console.error("ERROR CODE:", err.code);
        console.error("ERROR MESSAGE:", err.message);

        setLoading(btn, false, idleLabel);
        AUTH.submitting = false;

        if (recaptchaVerifier) {
            try {
                recaptchaVerifier.clear();
            } catch (e) {}

            recaptchaVerifier = null;
        }

        showError(err.message || "Could not send OTP. Please try again.");
    }
}

  /* -------------------------------------------------------------------
     VERIFY OTP — POST /api/verify-otp
  ------------------------------------------------------------------- */
  async function verifyOTP() {
    hideError();
    const code = collectOtpValue();

    if (code.length !== AUTH.otpLength) {
      flashOtpError();
      showError(`Enter the complete ${AUTH.otpLength}-digit code.`);
      return;
    }

    const btn = $("btnVerifyOTP");
    const idleLabel = "Verify OTP";
    setLoading(btn, true, idleLabel);

    // Firebase Phone Auth path: verify the SMS code with Firebase, get
    // the ID token, and hand it to the backend's dedicated phone-login
    // route. Email keeps using the existing backend OTP flow below,
    // completely untouched.
    if (AUTH.method === "phone" && phoneConfirmationResult) {
      try {
        const result = await phoneConfirmationResult.confirm(code);
        const idToken = await result.user.getIdToken();

        const { ok, data } = await authPost("/api/phone-login", { idToken });
        setLoading(btn, false, idleLabel);

        if (!ok || data.ok === false) {
          flashOtpError();
          showError((data && (data.message || data.error)) || "Incorrect OTP. Please try again.");
          return;
        }

        if (data.csrf_token) csrfToken = data.csrf_token;
        rememberMe(true);
        phoneConfirmationResult = null;
        await onAuthSuccess(data.user);
      } catch (err) {
        setLoading(btn, false, idleLabel);
        flashOtpError();
        showError((err && err.message) || "Incorrect OTP. Please try again.");
      }
      return;
    }

    const name = $("nameInput") ? $("nameInput").value.trim() : "";
    const payload = {
      mode: AUTH.mode,
      method: AUTH.method,
      otp: code,
      name,
      email: AUTH.method === "email" ? AUTH.otpTarget : undefined,
      phone: AUTH.method === "phone" ? AUTH.otpTarget : undefined
    };

    try {
      const { ok, data } = await authPost("/api/verify-otp", payload);
      setLoading(btn, false, idleLabel);
      if (!ok || data.ok === false) {
        flashOtpError();
        showError((data && (data.message || data.error)) || "Incorrect OTP. Please try again.");
        return;
      }
      if (data.csrf_token) csrfToken = data.csrf_token;
      rememberMe(true);
      await onAuthSuccess(data.user);
    } catch (e) {
      setLoading(btn, false, idleLabel);
      showError("Network error while verifying OTP. Please try again.");
    }
  }

  async function onAuthSuccess(user) {
    showStep("authStepSuccess");
    const successSub = $("authSuccessSub");
    if (successSub) {
      successSub.textContent = AUTH.mode === "register"
        ? "Your account is ready."
        : "You're logged in.";
    }
    // Prefer the freshly returned user, but fall back to a live session
    // check so the UI always reflects exactly what the server thinks.
    if (user) {
      cacheUser(user);
      reflectSessionInUI(user);
    } else {
      await checkSession();
    }
    setTimeout(() => {
      closeLogin();
    }, 1400);
  }

  /* -------------------------------------------------------------------
     OTP BOX BEHAVIOR — autofocus, paste support, backspace nav
  ------------------------------------------------------------------- */
  function clearOtpBoxes() {
    document.querySelectorAll(".otp-box").forEach((box) => {
      box.value = "";
      box.classList.remove("filled", "error-shake");
    });
  }

  function focusFirstOtpBox() {
    const first = document.querySelector(".otp-box");
    if (first) first.focus();
  }

  function collectOtpValue() {
    const boxes = Array.from(document.querySelectorAll(".otp-box"));
    return boxes.map((b) => b.value).join("").trim();
  }

  function flashOtpError() {
    document.querySelectorAll(".otp-box").forEach((box) => {
      box.classList.add("error-shake");
      setTimeout(() => box.classList.remove("error-shake"), 400);
    });
  }

  function initOtpBoxBehavior() {
    document.addEventListener("input", (e) => {
      if (!e.target.classList || !e.target.classList.contains("otp-box")) return;
      const val = e.target.value.replace(/[^0-9]/g, "").slice(0, 1);
      e.target.value = val;
      e.target.classList.toggle("filled", !!val);
      if (val) {
        const next = e.target.nextElementSibling;
        if (next && next.classList.contains("otp-box")) next.focus();
      }
    });

    document.addEventListener("keydown", (e) => {
      if (!e.target.classList || !e.target.classList.contains("otp-box")) return;
      if (e.key === "Backspace" && !e.target.value) {
        const prev = e.target.previousElementSibling;
        if (prev && prev.classList.contains("otp-box")) {
          prev.focus();
          prev.value = "";
          prev.classList.remove("filled");
        }
      }
    });

    document.addEventListener("paste", (e) => {
      if (!e.target.classList || !e.target.classList.contains("otp-box")) return;
      const pasted = (e.clipboardData || window.clipboardData).getData("text").replace(/[^0-9]/g, "");
      if (!pasted) return;
      e.preventDefault();
      const boxes = Array.from(document.querySelectorAll(".otp-box"));
      pasted.slice(0, boxes.length).split("").forEach((digit, i) => {
        boxes[i].value = digit;
        boxes[i].classList.add("filled");
      });
      const lastFilled = boxes[Math.min(pasted.length, boxes.length) - 1];
      if (lastFilled) lastFilled.focus();
    });
  }

  /* -------------------------------------------------------------------
     RESEND TIMER
  ------------------------------------------------------------------- */
  function startResendTimer() {
    clearInterval(AUTH.resendTimer);
    let remaining = AUTH.resendSeconds;
    const timerLabel = $("authResendTimer");
    const resendBtn = $("authResendBtn");
    if (resendBtn) resendBtn.disabled = true;

    const tick = () => {
      if (timerLabel) timerLabel.textContent = `Resend OTP in ${remaining}s`;
      if (remaining <= 0) {
        clearInterval(AUTH.resendTimer);
        if (timerLabel) timerLabel.textContent = "";
        if (resendBtn) resendBtn.disabled = false;
        return;
      }
      remaining -= 1;
    };
    tick();
    AUTH.resendTimer = setInterval(tick, 1000);
  }

  function resendOTP() {
    const resendBtn = $("authResendBtn");
    if (resendBtn && resendBtn.disabled) return;
    sendOTP();
  }

  /* -------------------------------------------------------------------
     LOGOUT — POST /api/logout
  ------------------------------------------------------------------- */
  async function logout() {
    try {
      await authPost("/api/logout", {});
    } catch (e) {
      // Proceed with client-side cleanup regardless of network failure.
    }
    clearCachedUser();
    csrfToken = null;
    await fetchCsrfToken();
    reflectSessionInUI(null);
    // Settings panel is an application-level UI element owned by
    // script.js; close it if it's open so logging out doesn't leave a
    // stale authenticated view showing.
    if (typeof window.closeSettings === "function") window.closeSettings();
  }

  /* -------------------------------------------------------------------
     SESSION CHECK — GET /api/check_session
  ------------------------------------------------------------------- */
  async function checkSession() {
    try {
      const { data } = await authGet("/api/check_session");
      if (data && data.logged_in && data.user) {
        cacheUser(data.user);
        reflectSessionInUI(data.user);
      } else {
        clearCachedUser();
        reflectSessionInUI(null);
      }
    } catch (e) {
      console.error("Session check failed:", e);
      // Fall back to any locally cached session (if remember-me allows
      // it) so the UI still reflects a logged-in state if the network
      // request fails, e.g. on a flaky connection.
      if (isRememberEnabled()) {
        reflectSessionInUI(getCachedUser());
      } else {
        reflectSessionInUI(null);
      }
    }
  }

  /* -------------------------------------------------------------------
     PROFILE UI SYNC — reflects the current auth state across every
     profile-related element that exists in index.html.
  ------------------------------------------------------------------- */
  function reflectSessionInUI(user) {
    const isAuthed = !!user;
    const displayName = isAuthed ? (user.name || user.email || "Member") : "Guest User";
    const displayEmail = isAuthed ? (user.email || "") : "guest@syra.ai";
    const initial = (isAuthed ? (user.name || user.email || "U") : "G").charAt(0).toUpperCase();

    const loginBtn = $("loginBtn");
    const logoutBtn = $("logoutBtn");
    if (loginBtn) loginBtn.style.display = isAuthed ? "none" : "inline-block";
    if (logoutBtn) logoutBtn.style.display = isAuthed ? "inline-block" : "none";

    const profileName = $("profileName");
    const profileEmail = $("profileEmail");
    if (profileName) profileName.textContent = displayName;
    if (profileEmail) profileEmail.textContent = displayEmail;

    const avatarInitial = $("avatarInitial");
    const avatarImg = $("avatarImg");
    if (avatarInitial) avatarInitial.textContent = initial;
    if (avatarImg) {
      if (isAuthed && user.photoURL) {
        avatarImg.src = user.photoURL;
        avatarImg.style.display = "block";
        if (avatarInitial) avatarInitial.style.display = "none";
      } else {
        avatarImg.style.display = "none";
        if (avatarInitial) avatarInitial.style.display = "flex";
      }
    }

    const nameEls = [$("menuName"), $("chatProfileName")];
    nameEls.forEach((el) => { if (el) el.textContent = displayName; });

    const initialEls = [$("menuAvatarInitial")];
    initialEls.forEach((el) => { if (el) el.textContent = initial; });
  }

  /* -------------------------------------------------------------------
     PUBLIC API + INIT
  ------------------------------------------------------------------- */
  window.openLogin = openLogin;
  window.closeLogin = closeLogin;
  // Backward-compatible aliases in case other markup references the
  // previous chat-specific modal handlers.
  window.openChatLogin = openLogin;
  window.closeChatLogin = closeLogin;

  window.toggleAuthMode = toggleAuthMode;
  window.toggleRegisterMode = toggleAuthMode;
  window.showEmailLogin = showEmailLogin;
  window.showPhoneLogin = showPhoneLogin;
  window.backToMethods = backToMethods;
  window.backToEntry = backToEntry;
  window.sendOTP = sendOTP;
  window.verifyOTP = verifyOTP;
  window.resendOTP = resendOTP;
  window.googleLogin = googleLogin;
  window.phoneLogin = phoneLogin;
  window.logout = logout;
  window.checkSession = checkSession;
  window.rememberMe = rememberMe;

  document.addEventListener("DOMContentLoaded", () => {
    initOtpBoxBehavior();
    fetchCsrfToken();
    checkSession();

    const overlay = $("loginModal");
    if (overlay) {
      overlay.addEventListener("click", (e) => {
        if (e.target === overlay) closeLogin();
      });
    }
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && overlay && overlay.classList.contains("open")) {
        closeLogin();
      }
    });
  });
})();
