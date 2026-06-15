// xr/session.js — immersive session lifecycle for the four-mode shell.
//
// Feature-detects immersive-vr and immersive-ar, shows the matching Enter button,
// and starts/stops sessions on the Three.js renderer. The flat (desktop/mobile)
// renderer is always the fallback and needs nothing here.
//
// We request sessions ourselves (rather than VRButton) so AR can ask for
// passthrough and both can share 'local-floor' reference space — that's what makes
// AR world-anchored (you physically walk) and VR stand at a sane floor height.
//
// Callbacks let main.js react without this module importing the scene:
//   onModeChange(mode)  — 'flat' | 'vr' | 'ar'
//   onARMode(on)        — toggle scene passthrough look

export async function setupXR(renderer, { btnVr, btnAr }, { onModeChange, onARMode }) {
  // local-floor puts the reference space origin on the physical floor, so avatar
  // feet and the stage platform line up with the real ground in AR.
  renderer.xr.setReferenceSpaceType('local-floor');

  const xr = navigator.xr;
  const supported = { vr: false, ar: false };

  if (xr) {
    // These can reject on locked-down browsers; treat any throw as "unsupported".
    supported.vr = await xr.isSessionSupported('immersive-vr').catch(() => false);
    supported.ar = await xr.isSessionSupported('immersive-ar').catch(() => false);
  }

  if (supported.vr) {
    btnVr.hidden = false;
    btnVr.addEventListener('click', () => start('immersive-vr'));
  }
  if (supported.ar) {
    btnAr.hidden = false;
    btnAr.addEventListener('click', () => start('immersive-ar'));
  }

  let active = null; // the live XRSession, or null in flat mode

  async function start(mode) {
    if (active) return; // already immersive
    const isAR = mode === 'immersive-ar';
    const sessionInit = isAR
      ? { optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking'] }
      : { optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking'] };

    let session;
    try {
      session = await xr.requestSession(mode, sessionInit);
    } catch (err) {
      console.warn(`[xr] ${mode} request failed:`, err);
      return;
    }

    active = session;
    await renderer.xr.setSession(session);

    if (isAR) onARMode(true);
    onModeChange(isAR ? 'ar' : 'vr');

    // 'end' fires for both our Exit (button/face-button) and a system exit.
    session.addEventListener('end', () => {
      active = null;
      if (isAR) onARMode(false);
      onModeChange('flat');
    });
  }

  return {
    supported,
    isImmersive: () => active !== null,
    end: () => active && active.end(),
  };
}
