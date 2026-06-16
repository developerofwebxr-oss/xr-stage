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
    voiceCount: $('voice-count'),
    speakerCount: $('speaker-count'),
    btnGyro: $('btn-gyro'),
    // transient
    voiceError: $('voice-error'),
    toast: $('toast'),
    lockHint: $('lock-hint'),
  };
  const modeBtns = { screen: el.modeScreen, vr: el.modeVr, ar: el.modeAr };
  let toastTimer = null;

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

    showLockHint(show) { el.lockHint.hidden = !show; },
    showGyro(show) { el.btnGyro.hidden = !show; },
    setGyro(on) { el.btnGyro.textContent = on ? 'Gyro: on' : 'Gyro: off'; },

    onVoice(fn) { el.btnVoice.addEventListener('click', fn); },
    onRequest(fn) { el.btnRequest.addEventListener('click', fn); },
    onZap(fn) { el.btnZap.addEventListener('click', fn); },
    onGyro(fn) { el.btnGyro.addEventListener('click', fn); },
  };
}
