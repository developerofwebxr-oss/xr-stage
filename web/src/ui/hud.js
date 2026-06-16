// ui/hud.js — thin wrapper over the DOM overlay declared in index.html.
//
// No framework: just grab the elements once and expose setters + button hooks.
// The HUD is plain DOM that floats over the canvas in flat/mobile modes and is
// hidden during immersive sessions (the in-world UI takes over there in later
// prompts; for now immersive simply has no 2D HUD).

const $ = (id) => document.getElementById(id);

export function createHud() {
  const el = {
    hud: $('hud'),
    modeLabel: $('mode-label'),
    roleLabel: $('role-label'),
    presenceCount: $('presence-count'),
    btnVr: $('btn-vr'),
    btnAr: $('btn-ar'),
    btnGyro: $('btn-gyro'),
    btnVoice: $('btn-voice'),          // the role-aware Listen/Speak toggle
    btnRequest: $('btn-request'),      // listener-only "Request to speak" placeholder
    voiceCount: $('voice-count'),
    speakerCount: $('speaker-count'),
    voiceStatus: $('voice-status'),
    voiceError: $('voice-error'),
    toast: $('toast'),
    lockHint: $('lock-hint'),
  };

  let toastTimer = null;

  return {
    el, // raw elements, for modules that wire their own listeners (xr buttons)

    setMode(mode) {
      el.modeLabel.textContent = mode;
      const immersive = mode === 'vr' || mode === 'ar';
      el.hud.style.display = immersive ? 'none' : '';
    },
    setRole(role) { el.roleLabel.textContent = role; },
    setParticipantCount(n) { el.presenceCount.textContent = String(n); },
    setSpeakerCount(n) {
      el.voiceCount.hidden = false;
      el.speakerCount.textContent = String(n);
    },

    // The role-aware Listen/Speak toggle: set its label + on/off look.
    setVoiceToggle(label) { el.btnVoice.textContent = label; },

    // Listener-only "Request to speak" placeholder (disabled, future phase).
    showRequest(show) { el.btnRequest.hidden = !show; },

    // Voice connection state: 'idle' | 'connecting' | 'connected' | 'failed'.
    // Drives the HUD badge text + colour and clears the error line unless failed.
    setVoiceState(state) {
      el.voiceStatus.textContent = state;
      el.voiceStatus.setAttribute('data-state', state);
      if (state !== 'failed') el.voiceError.hidden = true;
    },
    // Show a visible failure reason; the toggle label is left for main to reset.
    setVoiceError(msg) {
      el.voiceError.innerHTML = `voice error: <b>${msg}</b>`;
      el.voiceError.hidden = false;
    },

    // A small transient message (used by the disabled Request-to-speak button).
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
    onGyro(fn) { el.btnGyro.addEventListener('click', fn); },
  };
}
