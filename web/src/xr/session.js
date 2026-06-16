// xr/session.js — immersive session lifecycle for the four-mode shell.
//
// Feature-detects immersive-vr and immersive-ar and starts/stops sessions on the
// Three.js renderer. The flat (desktop/mobile) renderer is always the fallback.
// The UI is driven by the mode cluster (ui/hud.js): main wires the cluster to
// enter(); this module just reports support and runs sessions.
//
// We request sessions ourselves (rather than VRButton) so AR can ask for
// passthrough and both share 'local-floor' reference space — that's what makes AR
// world-anchored (you physically walk) and VR stand at a sane floor height.
//
// Callbacks:
//   onModeChange(mode)  — 'flat' | 'vr' | 'ar'
//   onARMode(on)        — toggle scene passthrough look

export async function setupXR(renderer, { onModeChange, onARMode }) {
  renderer.xr.setReferenceSpaceType('local-floor');

  const xr = navigator.xr;
  const supported = { vr: false, ar: false };
  if (xr) {
    supported.vr = await xr.isSessionSupported('immersive-vr').catch(() => false);
    supported.ar = await xr.isSessionSupported('immersive-ar').catch(() => false);
  }

  let active = null; // the live XRSession, or null in flat mode

  async function start(xrMode) {
    if (active) return;
    const isAR = xrMode === 'immersive-ar';
    const sessionInit = { optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking'] };

    let session;
    try {
      session = await xr.requestSession(xrMode, sessionInit);
    } catch (err) {
      console.warn(`[xr] ${xrMode} request failed:`, err);
      return;
    }

    active = session;
    await renderer.xr.setSession(session);
    if (isAR) onARMode(true);
    onModeChange(isAR ? 'ar' : 'vr');

    // 'end' fires for both our Exit (Screen button / face-button) and a system exit.
    session.addEventListener('end', () => {
      active = null;
      if (isAR) onARMode(false);
      onModeChange('flat');
    });
  }

  // Enter a mode from the cluster: 'screen' (return to flat), 'vr', or 'ar'.
  function enter(mode) {
    if (mode === 'screen') { if (active) active.end(); return; }
    if (mode === 'vr' && supported.vr) return start('immersive-vr');
    if (mode === 'ar' && supported.ar) return start('immersive-ar');
  }

  return { supported, enter, isImmersive: () => active !== null };
}
