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
    btnVoice: $('btn-voice'),
    btnMute: $('btn-mute'),
    voiceCount: $('voice-count'),
    speakerCount: $('speaker-count'),
    voiceStatus: $('voice-status'),
    voiceError: $('voice-error'),
    lockHint: $('lock-hint'),
  };

  return {
    el, // raw elements, for modules that wire their own listeners (xr buttons)

    setMode(mode) {
      el.modeLabel.textContent = mode;
      const immersive = mode === 'vr' || mode === 'ar';
      el.hud.style.display = immersive ? 'none' : '';
    },
    setRole(role) {
      el.roleLabel.textContent = role;
      // Mute toggle only makes sense for the speaker (listeners can't publish).
      el.btnMute.hidden = role !== 'speaker';
    },
    setParticipantCount(n) { el.presenceCount.textContent = String(n); },
    setSpeakerCount(n) {
      el.voiceCount.hidden = false;
      el.speakerCount.textContent = String(n);
    },
    setVoiceJoined() {
      el.btnVoice.disabled = true;
      el.btnVoice.textContent = 'Voice connected';
    },
    setMuted(muted) { el.btnMute.textContent = muted ? 'Unmute' : 'Mute'; },

    // Voice connection state: 'idle' | 'connecting' | 'connected' | 'failed'.
    // Drives the HUD badge text + colour and clears the error line unless failed.
    setVoiceState(state) {
      el.voiceStatus.textContent = state;
      el.voiceStatus.setAttribute('data-state', state);
      if (state !== 'failed') el.voiceError.hidden = true;
    },
    // Show a visible failure reason and offer a retry on the Join button.
    setVoiceError(msg) {
      el.voiceError.innerHTML = `voice error: <b>${msg}</b>`;
      el.voiceError.hidden = false;
      el.btnVoice.disabled = false;
      el.btnVoice.textContent = 'Join voice — retry';
    },

    showLockHint(show) { el.lockHint.hidden = !show; },
    showGyro(show) { el.btnGyro.hidden = !show; },
    setGyro(on) { el.btnGyro.textContent = on ? 'Gyro: on' : 'Gyro: off'; },

    onVoice(fn) { el.btnVoice.addEventListener('click', fn); },
    onMute(fn) { el.btnMute.addEventListener('click', fn); },
    onGyro(fn) { el.btnGyro.addEventListener('click', fn); },
  };
}
