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
    btnRecenter: $('btn-recenter'),
    btnVoice: $('btn-voice'),
    btnMute: $('btn-mute'),
    voiceCount: $('voice-count'),
    speakerCount: $('speaker-count'),
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
    showLockHint(show) { el.lockHint.hidden = !show; },
    showRecenter(show) { el.btnRecenter.hidden = !show; },

    onVoice(fn) { el.btnVoice.addEventListener('click', fn); },
    onMute(fn) { el.btnMute.addEventListener('click', fn); },
    onRecenter(fn) { el.btnRecenter.addEventListener('click', fn); },
  };
}
