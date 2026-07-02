// ui/hud.js — thin wrapper over the DOM overlay declared in index.html.
//
// No framework: grab the elements once and expose setters + button hooks for the
// top status bar, the bottom control bar, and the mode cluster. The overlay floats
// over the canvas in flat/mobile and is hidden during immersive sessions.

const $ = (id) => document.getElementById(id);

export function createHud() {
  const el = {
    hud: $('hud'),
    // top status
    roomLabel: $('room-label'),
    presenceCount: $('presence-count'),
    voiceDot: $('voice-dot'),
    voiceStatus: $('voice-status'),
    nowSpeaking: $('now-speaking'),
    // mode cluster
    modeScreen: $('mode-screen'),
    modeVr: $('mode-vr'),
    modeAr: $('mode-ar'),
    // control bar
    btnVoice: $('btn-voice'),
    btnRequest: $('btn-request'),
    btnZap: $('btn-zap'),
    walletBalance: $('wallet-balance'),
    walletBalanceVal: $('wallet-balance-val'),
    voiceCount: $('voice-count'),
    speakerCount: $('speaker-count'),
    btnFreelook: $('btn-freelook'),
    btnSignin: $('btn-signin'),
    btnMenu: $('btn-menu'),
    // pause menu + comfort
    pauseMenu: $('pause-menu'),
    pmResume: $('pm-resume'),
    pmExit: $('pm-exit'),
    pmVignette: $('pm-vignette'),
    pmSnapTurn: $('pm-snapTurn'),
    pmHaptics: $('pm-haptics'),
    vignette: $('vignette'),
    // transient
    voiceError: $('voice-error'),
    toast: $('toast'),
    lockHint: $('lock-hint'),
    freelookHint: $('freelook-hint'),
  };
  // comfort key → its checkbox, for the menu's persisted toggles.
  const comfortBoxes = { vignette: el.pmVignette, snapTurn: el.pmSnapTurn, haptics: el.pmHaptics };
  const modeBtns = { screen: el.modeScreen, vr: el.modeVr, ar: el.modeAr };
  let toastTimer = null;

  // Transient controls hint: fade in, auto-fade after `ms`, or hide on demand.
  let hintTimer = null;
  function hideLockHint() {
    clearTimeout(hintTimer);
    el.lockHint.classList.remove('show');
    hintTimer = setTimeout(() => { el.lockHint.hidden = true; }, 400); // after fade
  }
  function flashLockHint(ms = 4500) {
    clearTimeout(hintTimer);
    el.lockHint.hidden = false;
    void el.lockHint.offsetWidth; // reflow so the fade-in transition runs
    el.lockHint.classList.add('show');
    hintTimer = setTimeout(hideLockHint, ms);
  }

  return {
    el,

    // Hide/show the whole 2D overlay (hidden during immersive sessions).
    showOverlay(show) { el.hud.hidden = !show; },

    // ── Top status (B3) ────────────────────────────────────────────────────────
    setRoom(name) { el.roomLabel.textContent = name; },
    setParticipantCount(n) { el.presenceCount.textContent = String(n); },
    setVoiceState(state) {
      el.voiceStatus.textContent = state;
      el.voiceDot.setAttribute('data-state', state);
      if (state !== 'failed') el.voiceError.hidden = true;
    },
    setNowSpeaking(text) { el.nowSpeaking.textContent = text; },

    // ── Mode cluster (B2) ────────────────────────────────────────────────────────
    // Screen is always available; VR/AR are disabled (greyed + tooltip) when the
    // device can't do them.
    configureModes({ vr, ar }) {
      if (!vr) { el.modeVr.disabled = true; el.modeVr.title = 'VR not supported on this device'; }
      if (!ar) { el.modeAr.disabled = true; el.modeAr.title = 'AR not supported on this device'; }
    },
    setActiveMode(mode) { // 'screen' | 'vr' | 'ar'
      for (const [name, btn] of Object.entries(modeBtns)) btn.classList.toggle('active', name === mode);
    },
    onMode(fn) {
      for (const [name, btn] of Object.entries(modeBtns)) {
        btn.addEventListener('click', () => { if (!btn.disabled) fn(name); });
      }
    },

    // ── Control bar (B1) ──────────────────────────────────────────────────────────
    setVoiceToggle(label, on) {
      el.btnVoice.textContent = label;
      el.btnVoice.classList.toggle('on', !!on);
    },
    showRequest(show) { el.btnRequest.hidden = !show; },
    // Wallet balance readout beside the Zap control (shown once a wallet connects).
    showBalance(show) { el.walletBalance.hidden = !show; },
    setBalance(sats) { el.walletBalanceVal.textContent = Number(sats).toLocaleString('en-US'); },
    setSpeakerCount(n) {
      el.voiceCount.hidden = false;
      el.speakerCount.textContent = String(n);
    },
    setVoiceError(msg) {
      el.voiceError.innerHTML = `voice error: <b>${msg}</b>`;
      el.voiceError.hidden = false;
    },
    toast(msg) {
      el.toast.textContent = msg;
      el.toast.classList.add('show');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => el.toast.classList.remove('show'), 2200);
    },

    flashLockHint, hideLockHint,                       // transient controls hint
    showFreeLookHint(show) { el.freelookHint.hidden = !show; }, // desktop ESC hint
    // Unified "Free look" toggle (desktop pointer-lock / mobile gyro).
    showFreeLook(show) { el.btnFreelook.hidden = !show; },
    setFreeLook(on) { el.btnFreelook.textContent = on ? 'Free look: on' : 'Free look: off'; },

    // Mock sign-in control. Before: "Sign in". After: a compact "me" chip showing
    // the keyface + name (the "signed in as …" indicator). info = { name, faceUrl }.
    setSignedIn(info) {
      if (!info) { el.btnSignin.classList.remove('me'); el.btnSignin.textContent = 'Sign in'; return; }
      el.btnSignin.classList.add('me');
      el.btnSignin.title = `Signed in as ${info.name}`;
      el.btnSignin.innerHTML = `<img class="me-face" alt="" src="${info.faceUrl}"><span>${info.name}</span>`;
    },

    onVoice(fn) { el.btnVoice.addEventListener('click', fn); },
    onRequest(fn) { el.btnRequest.addEventListener('click', fn); },
    onZap(fn) { el.btnZap.addEventListener('click', fn); },
    onFreeLook(fn) { el.btnFreelook.addEventListener('click', fn); },
    onSignIn(fn) { el.btnSignin.addEventListener('click', fn); },

    // ── Pause / Menu + comfort (X · Esc·M · ☰) ────────────────────────────────────
    showMenu(show) { el.pauseMenu.hidden = !show; },
    isMenuOpen() { return !el.pauseMenu.hidden; },
    onMenuButton(fn) { el.btnMenu.addEventListener('click', fn); },
    onResume(fn) { el.pmResume.addEventListener('click', fn); },
    onExit(fn) { el.pmExit.addEventListener('click', fn); },
    // Reflect comfort state into the checkboxes (called on open, for persistence).
    setComfort(state) {
      for (const [k, box] of Object.entries(comfortBoxes)) if (box) box.checked = !!state[k];
    },
    // fn(key, checked) when the user flips a comfort toggle.
    onComfortToggle(fn) {
      for (const [k, box] of Object.entries(comfortBoxes)) {
        if (box) box.addEventListener('change', () => fn(k, box.checked));
      }
    },

    // ── Comfort vignette (flat) ───────────────────────────────────────────────────
    setVignetteVisible(on) {
      el.vignette.hidden = !on;
      if (!on) el.vignette.style.opacity = '0';
    },
    setVignetteLevel(level) { el.vignette.style.opacity = String(Math.max(0, Math.min(1, level))); },
  };
}
