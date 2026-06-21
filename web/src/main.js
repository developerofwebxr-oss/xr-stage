import * as THREE from 'three';
import { config } from './config.js';
import { buildScene } from './room/scene.js';
import { STAGE_POS, STAGE_TOP_Y, QUESTIONER_POS, constrainPosition, boundaryFor } from './room/zones.js';
import { seedPlaceholders, createPlayerBody, applyIdentity, MIN_BODY_GAP } from './room/avatars.js';
import { identity } from './identity/identity.js';
import { drawKeyface } from './identity/keyface.js';
import { createLocomotion } from './xr/locomotion.js';
import { setupXR } from './xr/session.js';
import { createHud } from './ui/hud.js';
import { createJoystick } from './ui/joystick.js';
import { createProfileCard } from './ui/profileCard.js';
import { Voice } from './voice/livekit.js';
import { createPresence } from './state/presence.js';
import { stageState, setState, onStateChange } from './state/stageState.js';

// main.js — boots the four-mode WebXR spatial stage and runs the frame loop.
// Wiring only: each concern lives in its own module; here we connect their seams.

// ── Renderer ────────────────────────────────────────────────────────────────────
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.xr.enabled = true;
document.getElementById('app').appendChild(renderer.domElement);
// Drawing-buffer size is driven by syncViewport() (below) off the live visual
// viewport; the canvas's *display* size is CSS (100vw/100dvh), so we never write
// stale inline width/height. (Initial sizing happens after the camera exists.)

// ── Scene + people ──────────────────────────────────────────────────────────────
const { scene, setARMode, update: updateScene } = buildScene();
// Static ambiance capsules; positions feed avatar separation; groups get identities.
const seeded = seedPlaceholders(scene);
const staticBodies = seeded.map((s) => s.position);

// ── Identity (Phase 2, mock) ──────────────────────────────────────────────────────
// Every avatar is keyed by a pubkey (mock-derived from its stable id) → profile →
// keyface + name, all via the identity service (the single source of identity). The
// real swap (nostr-tools + NIP-07) lives behind this same service — callers unchanged.
function identifyAvatar(group, seedId) {
  const pubkey = identity.pubkeyFromSeed(seedId);
  identity.getProfile(pubkey).then((profile) => {
    applyIdentity(group, { pubkey, npub: identity.npubFromPubkey(pubkey), ...profile });
  });
}
seeded.forEach((s, i) => identifyAvatar(s.group, `seed-${i}`)); // ambiance crowd

const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.05, 200);

// Who am I, spatially? Drives spawn + the movement clamp (A2/A3).
const who = { role: config.role, isNextUp: config.isNextUp };

// Mobile = coarse pointer, no fine pointer (per the skill — not viewport width).
// Picks the Free-look mechanism (gyro vs pointer-lock) + shows the joystick.
const isMobile = matchMedia('(pointer: coarse)').matches && !matchMedia('(pointer: fine)').matches;
let freeLookOn = false;

// ── Role-based spawn ──────────────────────────────────────────────────────────
// Speaker: on the main stage near the front, facing the audience (+Z).
// Next-up: on the mic platform in front of the mic, facing the speaker (-Z).
// Audience: in front of the structure, facing it (-Z).
let spawn;
if (who.role === 'speaker')   spawn = { position: [STAGE_POS.x, STAGE_TOP_Y, STAGE_POS.z + 1.5], yaw: Math.PI };
else if (who.isNextUp)        spawn = { position: [QUESTIONER_POS.x, QUESTIONER_POS.y, QUESTIONER_POS.z], yaw: 0 };
else                          spawn = { position: [STAGE_POS.x, 0, STAGE_POS.z + 13], yaw: 0 };

// ── Boundary glow: flares when the player hits their zone edge ───────────────────
// A ring on the stage edge (speaker/audience) or a rectangle outline on the mic
// platform (next-up). Shared material so one fade drives whichever shape.
const bnd = boundaryFor(who);
let ringMat, boundaryRing;
if (bnd.shape === 'rect') {
  ringMat = new THREE.LineBasicMaterial({ color: 0xf7931a, transparent: true, opacity: 0 });
  const hw = bnd.w / 2, hd = bnd.d / 2;
  const pts = [
    new THREE.Vector3(-hw, 0, -hd), new THREE.Vector3(hw, 0, -hd),
    new THREE.Vector3(hw, 0, hd), new THREE.Vector3(-hw, 0, hd), new THREE.Vector3(-hw, 0, -hd),
  ];
  boundaryRing = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), ringMat);
} else {
  ringMat = new THREE.MeshBasicMaterial({
    color: 0xf7931a, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false,
  });
  boundaryRing = new THREE.Mesh(new THREE.TorusGeometry(bnd.radius, 0.06, 12, 96), ringMat);
  boundaryRing.rotation.x = -Math.PI / 2;
}
boundaryRing.position.set(bnd.centre.x, bnd.y, bnd.centre.z);
scene.add(boundaryRing);
let boundaryGlow = 0;

const { rig, update: updateLocomotion, setFreeLook, setMoveInput, jump } =
  createLocomotion(camera, renderer.domElement, {
    spawn,
    isMobile,
    constrain: (x, z) => constrainPosition(who, x, z),
    onBoundary: () => { boundaryGlow = 1; }, // soft edge stop + glow, no snap-back
    // Pointer lock dropped on its own (e.g. Esc) → reflect it in the toggle + hide
    // the ESC hint, so the button and pointer-lock state never get out of sync.
    onFreeLookEnd: () => { freeLookOn = false; hud.setFreeLook(false); hud.showFreeLookHint(false); },
  });
scene.add(rig);

// Local player body (capsule), parented to the rig so it moves + turns with us.
rig.add(createPlayerBody(who.role === 'speaker' ? 0xf7931a : 0x4cc2ff));

// ── HUD ─────────────────────────────────────────────────────────────────────────
const hud = createHud();
hud.setRoom(config.room);
stageState.role = config.role;

// Desktop hint (fine pointer only): default look is hold-drag. Show it briefly,
// then fade after a few seconds OR on the first look/move input, whichever's first.
if (!isMobile) {
  hud.flashLockHint();
  const hideHint = () => hud.hideLockHint();
  addEventListener('keydown', hideHint, { once: true });            // WASD etc.
  renderer.domElement.addEventListener('pointerdown', hideHint, { once: true }); // drag-look
}

// Mobile-only: the on-screen joystick (movement). Look is drag / gyro via Free look.
if (isMobile) {
  document.body.classList.add('mobile');
  createJoystick(document.getElementById('joystick'), {
    onMove: (strafe, forward) => setMoveInput(strafe, forward),
  });

  // Jump button, bottom-right (mirrors the joystick). pointerdown (not click) so the
  // hop fires instantly; preventDefault keeps it from also starting a look-drag.
  const jumpBtn = document.getElementById('jump-btn');
  jumpBtn.hidden = false;
  jumpBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); jump(); });

  // The control bar docks flush at the bottom (CSS); the joystick floats above it.
  // Publish the bar's live height as --control-bar-h so the joystick (and toasts)
  // always clear it — the bar is 1 row in landscape, 2 in portrait.
  const controlbar = document.getElementById('controlbar');
  const setBarHeight = () =>
    document.documentElement.style.setProperty('--control-bar-h', `${controlbar.offsetHeight}px`);
  if (window.ResizeObserver) new ResizeObserver(setBarHeight).observe(controlbar);
  addEventListener('resize', setBarHeight);
  setBarHeight();
}

// ── Free look toggle (every device) ─────────────────────────────────────────────
// OFF (default): hold-drag (desktop) / touch-drag (mobile). ON: pointer-lock free
// mouse (desktop) / smoothed gyro (mobile). One toggle, device-appropriate mechanism.
hud.showFreeLook(true);
hud.setFreeLook(false);
hud.onFreeLook(async () => {
  const turningOn = !freeLookOn;
  const ok = await setFreeLook(turningOn);
  if (turningOn && !ok) { hud.el.btnFreelook.textContent = 'Free look: denied'; return; }
  freeLookOn = turningOn;
  hud.setFreeLook(freeLookOn);
  hud.hideLockHint();                                  // toggling is an input
  if (!isMobile) hud.showFreeLookHint(freeLookOn);     // desktop pointer-lock ESC hint
});

// ── Sign in (mock identity) ───────────────────────────────────────────────────────
// signIn() goes through the identity service; the chip shows your keyface + name.
// REAL: 'nip07' on desktop, 'generate' on mobile/VR, 'guest' anywhere — the mock
// ignores the distinction but the method param is kept so the swap is clean.
const signInMethod = isMobile ? 'generate' : 'nip07';
hud.onSignIn(async () => {
  const me = await identity.signIn(signInMethod);
  hud.setSignedIn({ name: me.name, faceUrl: drawKeyface(me.pubkey, 64).toDataURL() });
});

// ── WebXR sessions + mode cluster (B2) ──────────────────────────────────────────
// Screen is active by default; VR/AR enable + wire once feature-detection resolves.
hud.setActiveMode('screen');
setupXR(renderer, {
  onModeChange: (mode) => {
    hud.setActiveMode(mode === 'flat' ? 'screen' : mode);
    hud.showOverlay(mode === 'flat');            // no 2D HUD inside immersive
    document.getElementById('joystick').hidden = mode !== 'flat' ? true : !isMobile;
    document.getElementById('jump-btn').hidden = mode !== 'flat' ? true : !isMobile;
    if (mode === 'flat' && !isMobile) hud.flashLockHint(); // brief reminder on return
    if (mode !== 'flat') hud.showFreeLookHint(false);
  },
  onARMode: (on) => setARMode(on),
}).then((xr) => {
  hud.configureModes(xr.supported); // grey out VR/AR the device can't do
  hud.onMode((m) => xr.enter(m));
});

// ── Voice + presence ─────────────────────────────────────────────────────────────
const voice = new Voice({
  onCounts: ({ participantCount, speakerCount }) => setState({ participantCount, speakerCount }),
  onState: (state) => hud.setVoiceState(state),
});

// Presence exists from the start so avatar separation (incl. static props) is always
// active. The heartbeat send/receive only carries data once voice connects (sendData
// no-ops with no room), so nothing leaks before the user joins.
const presence = createPresence(voice, scene, () => ({
  x: rig.position.x, y: rig.position.y, z: rig.position.z, yaw: rig.rotation.y,
}), staticBodies, {
  // Each remote peer gets a mock identity (face + name) keyed by its presence id.
  // REAL: presence carries the peer's pubkey; this becomes getProfile(pubkey).
  onAvatarSpawn: (id, group) => identifyAvatar(group, id),
});

// ── Click an avatar → fixed profile card (Phase 2.2 → 2.3) ───────────────────────
// Plain click raycasts to an avatar (the click stays free — never pointer-locks);
// hold-drag still looks. VR uses the controller select ray. The card is a FIXED DOM
// panel (always the same size/position, readable for near OR far avatars); a ring
// marks the selected avatar. One card at a time.
const raycaster = new THREE.Raycaster();

// Pickable avatar roots: seeded ambiance + live remote peers (NOT your own body).
const pickables = () => seeded.map((s) => s.group).concat(presence.avatars());

// Selection cue: one reusable ring, parented to the selected avatar so it follows.
const selectionRing = new THREE.Mesh(
  new THREE.TorusGeometry(0.42, 0.03, 10, 44),
  new THREE.MeshBasicMaterial({ color: 0xf7931a, transparent: true, opacity: 0.9, depthWrite: false }),
);
selectionRing.rotation.x = -Math.PI / 2;
let selectedGroup = null;

// Actions behind the SAME named handlers from 2.2 (Follow = mock toggle, Zap = stub),
// just rendered in the fixed DOM card now — real swaps don't touch this.
function onVisit(profile) {
  if (renderer.xr.isPresenting) return;                       // VR: profile opens on desktop
  window.open(`https://njump.me/${profile.npub}`, '_blank', 'noopener');
}
function onFollow(profile) {
  card.setFollowing(identity.toggleFollow(profile.pubkey));   // REAL: publish a kind:3 list
}
function onZap() {
  // SEAM: routes to the (not-yet-built) wallet/zap service. No payment logic here.
  if (!renderer.xr.isPresenting) hud.toast('Wallet coming soon');
}

const card = createProfileCard({ onVisit, onFollow, onZap, onClose: deselect });

function selectAvatar(group, profile) {
  group.add(selectionRing);              // ring follows the avatar
  selectionRing.position.set(0, 0.06, 0);
  selectedGroup = group;
  card.open(profile, { following: identity.isFollowing(profile.pubkey) });
}
function deselect() {
  if (selectionRing.parent) selectionRing.parent.remove(selectionRing);
  selectedGroup = null;
  card.close();
}

function pickAvatarGroup() {
  const hits = raycaster.intersectObjects(pickables(), true);
  for (const h of hits) {
    let o = h.object;
    while (o) { if (o.userData && o.userData.identity) return o; o = o.parent; }
  }
  return null;
}

// Pick an avatar (toggle-close on the same one) or close on empty space. Card
// buttons are DOM, handled inside the card — they never reach this raycast.
function pickFromRaycaster() {
  const group = pickAvatarGroup();
  if (group) {
    if (group === selectedGroup) deselect();                 // same avatar → close
    else selectAvatar(group, group.userData.identity);       // replaces any open card
    return;
  }
  deselect();                                                // empty space → close
}

// Flat: a tap (pointer down→up with little movement) that isn't pointer-locked.
{
  const _ndc = new THREE.Vector2();
  const dom = renderer.domElement;
  let downX = 0, downY = 0, moved = false;
  dom.addEventListener('pointerdown', (e) => { downX = e.clientX; downY = e.clientY; moved = false; });
  dom.addEventListener('pointermove', (e) => { if (Math.hypot(e.clientX - downX, e.clientY - downY) > 6) moved = true; });
  dom.addEventListener('pointerup', (e) => {
    if (moved || document.pointerLockElement === dom) return; // drag-look / free look → not a pick
    const r = dom.getBoundingClientRect();
    _ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(_ndc, camera);
    pickFromRaycaster();
  });
}

// VR: the controller select ray picks the avatar / card.
{
  const _m = new THREE.Matrix4();
  for (let i = 0; i < 2; i++) {
    const controller = renderer.xr.getController(i);
    rig.add(controller); // controllers live in the rig's (reference) space
    controller.addEventListener('select', () => {
      _m.identity().extractRotation(controller.matrixWorld);
      raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
      raycaster.ray.direction.set(0, 0, -1).applyMatrix4(_m).normalize();
      pickFromRaycaster();
    });
  }
}

onStateChange((s) => {
  hud.setParticipantCount(s.participantCount);
  hud.setSpeakerCount(s.speakerCount);
  // Placeholder until Nostr names land (Phase 2): summarise by count.
  hud.setNowSpeaking(s.speakerCount > 0 ? 'Someone speaking' : '— no one speaking —');
});

// Role-aware Listen/Speak toggle; first "on" tap joins + satisfies autoplay.
const isSpeaker = config.role === 'speaker';
const verb = isSpeaker ? 'Speak' : 'Listen';
let active = false;

hud.setVoiceToggle(`${verb}: off`, false);
hud.showRequest(!isSpeaker);                              // listener-only placeholder
hud.onRequest(() => hud.toast('Request to speak — available in a later phase'));
hud.onZap(() => hud.toast('Zaps arrive in a later phase')); // reserved Phase 3 slot

hud.onVoice(async () => {
  const next = !active;
  hud.el.btnVoice.disabled = true;
  try {
    if (!voice.isConnected) {
      await voice.connect();
      await voice.setListening(true); // resume audio playback within the gesture
      // presence already exists; its heartbeat starts flowing now that we're connected.
    }
    if (isSpeaker) await voice.setMicEnabled(next);
    else await voice.setListening(next);
    active = next;
    hud.setVoiceToggle(`${verb}: ${active ? 'on' : 'off'}`, active);
  } catch (err) {
    hud.setVoiceError(err.message || 'unknown error');
  } finally {
    hud.el.btnVoice.disabled = false;
  }
});

// ── Viewport tracking ────────────────────────────────────────────────────────────
// Size the drawing buffer to the LIVE visual viewport (handles mobile URL-bar
// show/hide + rotation), not the stale layout viewport. CSS sizes the canvas's
// display (100vw/100dvh), so setSize passes updateStyle=false — no stale inline px.
const vv = window.visualViewport;
function syncViewport() {
  const w = Math.round(vv ? vv.width : innerWidth);
  const h = Math.round(vv ? vv.height : innerHeight);
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

// rAF-debounced so a burst of events settles to one measure on the next frame.
let resizeRAF = null;
function onViewportChange() {
  if (resizeRAF) cancelAnimationFrame(resizeRAF);
  resizeRAF = requestAnimationFrame(syncViewport);
}
addEventListener('resize', onViewportChange);
// orientationchange reports stale dimensions synchronously → also re-measure once
// more after the rotation settles.
addEventListener('orientationchange', () => { onViewportChange(); setTimeout(syncViewport, 300); });
if (vv) {
  vv.addEventListener('resize', onViewportChange);
  vv.addEventListener('scroll', onViewportChange); // URL bar scrolling away
}
syncViewport(); // initial

// ── Frame loop ──────────────────────────────────────────────────────────────────
const clock = new THREE.Clock();

renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.1);
  updateScene(dt);            // scene mood: ring spread + star flicker (GPU clocks)
  updateLocomotion(dt, renderer);
  presence.update(dt);
  // Nudge the local rig out of the deepest overlap with any body (live or static),
  // keeping centres >= MIN_BODY_GAP (heads never intersect), then re-clamp so the
  // nudge can't push us into a forbidden zone.
  const push = presence.separation(rig.position, MIN_BODY_GAP);
  if (push) {
    const c = constrainPosition(who, rig.position.x + push.x, rig.position.z + push.z);
    rig.position.set(c.x, c.y, c.z);
  }
  // Fade the boundary glow (held at full while the player pushes the edge).
  if (boundaryGlow > 0) { boundaryGlow = Math.max(0, boundaryGlow - dt * 1.6); ringMat.opacity = boundaryGlow * 0.6; }
  renderer.render(scene, camera);
});
