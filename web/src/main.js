import * as THREE from 'three';
import { config } from './config.js';
import { buildScene } from './room/scene.js';
import { STAGE_POS, STAGE_RADIUS, STAGE_TOP_Y, QUESTIONER_POS, constrainPosition, boundaryFor } from './room/zones.js';
import { seedPlaceholders, createPlayerBody, applyIdentity, MIN_BODY_GAP } from './room/avatars.js';
import { identity } from './identity/identity.js';
import { drawKeyface } from './identity/keyface.js';
import { createLocomotion } from './xr/locomotion.js';
import { comfort } from './input/comfort.js';
import { setupXR } from './xr/session.js';
import { createHud } from './ui/hud.js';
import { createJoystick } from './ui/joystick.js';
import { createProfileCard } from './ui/profileCard.js';
import { createZapUI } from './ui/zapUI.js';
import { createMenus } from './ui/menus.js';
import { createBoardUI } from './ui/boardUI.js';
import { board } from './board/board.js';
import { createCommentBoard } from './room/commentBoard.js';
import { wallet } from './wallet/wallet.js';
import { createZapEffects } from './room/zapEffect.js';
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

// AR shell-off swaps room-bounds for per-prop collision (zones.js `ar` flag); set
// when an AR session is active so locomotion's clamp lets the player roam the real room.
let arActive = false;

const { rig, update: updateLocomotion, setFreeLook, setMoveInput, jump } =
  createLocomotion(camera, renderer.domElement, {
    spawn,
    isMobile,
    constrain: (x, z) => constrainPosition(who, x, z, arActive),
    onBoundary: () => { boundaryGlow = 1; }, // soft edge stop + glow, no snap-back
    // Pointer lock dropped on its own (e.g. Esc) → reflect it in the toggle + hide
    // the ESC hint, so the button and pointer-lock state never get out of sync.
    onFreeLookEnd: () => { freeLookOn = false; hud.setFreeLook(false); hud.showFreeLookHint(false); },
    // Cross-input parity: these verbs are also bound on the desktop keys (inside
    // locomotion) — here we route them to this game's actions. One handler per verb,
    // shared by VR buttons + keyboard, so nothing is improvised per-platform.
    onMenu: () => toggleMenu(),       // X / Esc·M  → Pause/Menu
    onGrab: () => doGrab(),           // grip / E-hold·right-click → grab (inert seam)
    onVerbB: () => toggleVoice(),     // B / B-key  → game verb: toggle mic (Listen/Speak)
    onVerbY: () => zapSelected(),     // Y / Y-key  → game verb: zap the selected avatar
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

// ── Identity → the "You" home ────────────────────────────────────────────────────
// The control-bar "You" chip opens the You menu (its home); the actual sign-in/switch/
// log-out live inside it. signInFlow() goes through the identity service and updates
// the chip. REAL: 'nip07' desktop, 'generate' mobile/VR — the mock ignores it.
const signInMethod = isMobile ? 'generate' : 'nip07';
async function signInFlow() {
  const me = await identity.signIn(signInMethod);
  hud.setSignedIn({ name: me.name, faceUrl: drawKeyface(me.pubkey, 64).toDataURL() });
  return me;
}
hud.onSignIn(() => openYou());   // "You" control-bar chip → You menu
hud.onStage(() => openStage());  // "Stage" control-bar button → Stage menu

// ── WebXR sessions + mode cluster (B2) ──────────────────────────────────────────
// Screen is active by default; VR/AR enable + wire once feature-detection resolves.
let xrCtl = null; // the session controller; exposes enter('screen'|'vr'|'ar')
hud.setActiveMode('screen');
setupXR(renderer, {
  onModeChange: (mode) => {
    hud.setActiveMode(mode === 'flat' ? 'screen' : mode);
    hud.showOverlay(mode === 'flat');            // no 2D HUD inside immersive
    document.getElementById('joystick').hidden = mode !== 'flat' ? true : !isMobile;
    document.getElementById('jump-btn').hidden = mode !== 'flat' ? true : !isMobile;
    if (mode !== 'flat') closeAllMenus();        // leaving flat closes all DOM menus
    if (mode === 'flat' && !isMobile) hud.flashLockHint(); // brief reminder on return
    if (mode !== 'flat') hud.showFreeLookHint(false);
  },
  // AR = shell-off: passthrough look + per-prop collision (arActive flips the clamp).
  onARMode: (on) => { arActive = on; setARMode(on); },
}).then((xr) => {
  xrCtl = xr;
  hud.configureModes(xr.supported); // grey out VR/AR the device can't do
  hud.onMode((m) => xr.enter(m));
});

// ── Pause / Menu + comfort layer (X · Esc·M · ☰) ─────────────────────────────────
// One menu, opened from any reality's menu binding. Resume closes it; "Exit to screen
// mode" is the in-app exit path (the platform button is the other). Comfort toggles
// are ALL off by default and PERSISTED (comfort.js) — opt-in only, never baked on.
function toggleMenu() { hud.isMenuOpen() ? hud.showMenu(false) : openMenu(); }
function openMenu() { closeAllMenus(); hud.setComfort(comfort.all()); hud.showMenu(true); }
hud.onMenuButton(toggleMenu);
hud.onResume(() => hud.showMenu(false));
hud.onInstructions(() => openInstructions());
hud.onShare(() => shareInvite());
hud.onExit(() => { hud.showMenu(false); xrCtl?.enter('screen'); }); // ends VR/AR; no-op in flat
hud.onComfortToggle((key, on) => comfort.set(key, on));

// ── Menu shell: the five homes, one-at-a-time ────────────────────────────────────
// Every full-screen surface routes through here so opening one closes the others
// (the profile card is a corner panel and coexists). menus/zapUI are created in the
// wallet section below; these coordinators only run on user interaction.
function closeAllMenus() { hud.showMenu(false); zapUI.closeAll(); menus.closeAll(); boardUI.closeAll(); }
function openYou() {
  closeAllMenus();
  const me = identity.current();
  menus.openYou({
    signedIn: !!me,
    name: me?.name || null,
    faceUrl: me ? drawKeyface(me.pubkey, 64).toDataURL() : null,
    walletConnected: wallet.isConnected(),
    balance: wallet.getBalance(),
  });
}
function openStage() { closeAllMenus(); menus.openStage(); }
function openInstructions() { closeAllMenus(); menus.openInstructions(); }
function openBooking() { closeAllMenus(); menus.openBooking(); }
function openSpendHub() { closeAllMenus(); zapUI.openHub({ speakerAvailable: !!stageSpeakerGroup() }); }

// Share the one-link URL to the clipboard. Primary path is the async Clipboard API
// (works on a real gesture in a secure context); fall back to a hidden-textarea
// execCommand copy, and if even that fails, surface the URL so it's never a dead end.
async function shareInvite() {
  const url = location.href;
  try {
    await navigator.clipboard.writeText(url);
    hud.toast('Link copied');
    return;
  } catch { /* fall through to the legacy path */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = url;
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    document.body.appendChild(ta);
    ta.focus(); ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    hud.toast(ok ? 'Link copied' : `Copy failed — ${url}`);
  } catch {
    hud.toast(`Copy failed — ${url}`);
  }
}

// Apply comfort live: vignette visibility follows its toggle (snapTurn/haptics are
// read where they act — locomotion turn + the pulse() helper). Persisted changes
// re-apply on load too.
function applyVignettePref() { hud.setVignetteVisible(comfort.get('vignette')); }
comfort.onChange((key) => { if (key === 'vignette') applyVignettePref(); });
applyVignettePref();

// Haptic pulse on the active controllers (VR only, opt-in). Used by select + grab;
// land/jump haptics are a small follow-up (needs a locomotion onLand hook).
function pulse(intensity = 0.4, ms = 40) {
  if (!comfort.get('haptics') || !renderer.xr.isPresenting) return;
  const session = renderer.xr.getSession();
  for (const src of session?.inputSources || []) {
    src.gamepad?.hapticActuators?.[0]?.pulse?.(intensity, ms);
  }
}

// Grab (inert seam): the unified secondary-pointer verb, bound on grip / E-hold /
// right-click per the standard. This venue has no grabbable props yet, so it's a
// no-op beyond the haptic + a toast — the architecture is in place for a future slice
// that adds grabbable objects (raycast nearest interactable, parent to the hand).
function doGrab() {
  pulse(0.5, 50);
  if (!renderer.xr.isPresenting) hud.toast('Nothing to grab here yet');
}

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
function onZap(profile) {
  // The wallet/zap seam is LIVE now (mock): the card's Zap routes through the one
  // unified zap-avatar flow (flat/mobile → amount picker, VR → quick-zap).
  zapAvatar(profile.pubkey, profile.name);
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

// ONE raycast, two targets (per the standard's "select" pointer role): a comment card
// on a screen → zap-to-boost it; an avatar → open/close its profile card. Nearest hit
// wins. Desktop click, mobile tap and the VR controller select all feed this.
function pickFromRaycaster() {
  // Sprites (avatar name labels, zap bursts) need raycaster.camera to project — the
  // VR controller path sets the ray directly (not setFromCamera), so ensure it here or
  // Sprite.raycast throws on a null camera.
  raycaster.camera = camera;
  const targets = pickables().concat(commentBoard.pickables());
  const hits = raycaster.intersectObjects(targets, true);
  for (const h of hits) {
    let o = h.object;
    while (o) {
      if (o.userData && o.userData.commentId) { boostComment(o.userData.commentId); return; }
      if (o.userData && o.userData.identity) {
        if (o === selectedGroup) deselect();                 // same avatar → close
        else selectAvatar(o, o.userData.identity);           // replaces any open card
        return;
      }
      o = o.parent;
    }
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
    if (e.button !== 0) return;                               // left-click selects; right-click = grab
    if (moved || document.pointerLockElement === dom) return; // drag-look / free look → not a pick
    const r = dom.getBoundingClientRect();
    _ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(_ndc, camera);
    pickFromRaycaster();
  });
}

// XR: the controller (or AR screen-tap) select ray feeds the SAME pickFromRaycaster
// as the desktop click — one "select avatar" path for every input. Each controller
// gets a visible aiming ray so the user can point.
{
  const _m = new THREE.Matrix4();
  for (let i = 0; i < 2; i++) {
    const controller = renderer.xr.getController(i); // target-ray space
    rig.add(controller); // controllers live in the rig's (reference) space

    // Aiming ray — hidden until a controller connects in an XR session (so it never
    // shows as a stray line in flat mode, and is skipped for AR's screen-tap input).
    const ray = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -5)]),
      new THREE.LineBasicMaterial({ color: 0xf7931a, transparent: true, opacity: 0.6 }),
    );
    ray.visible = false;
    controller.add(ray);
    controller.addEventListener('connected', (e) => { ray.visible = e.data?.targetRayMode !== 'screen'; });
    controller.addEventListener('disconnected', () => { ray.visible = false; });

    controller.addEventListener('select', () => {
      _m.identity().extractRotation(controller.matrixWorld);
      raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
      raycaster.ray.direction.set(0, 0, -1).applyMatrix4(_m).normalize();
      pulse(0.3, 30);          // select/fire haptic (opt-in via the comfort menu)
      pickFromRaycaster();
    });
  }
}

// ── Wallet + zap (Phase 3, mock) ─────────────────────────────────────────────────
// The wallet service is the ONE source of balance + zaps, SEPARATE from identity
// (signing ≠ paying). All three zap seams — the profile-card Zap, the control-bar Zap
// (spend hub), and the Y binding — funnel through ONE zap-avatar flow: flat/mobile
// opens the amount picker, VR quick-zaps a default. Real Lightning (NWC/LNbits) swaps
// in behind wallet.js without touching any caller here.
const DEFAULT_ZAP = 21; // sats — the VR quick-zap amount (no DOM picker in immersive)
const zapFx = createZapEffects();
const fmtSats = (n) => n.toLocaleString('en-US');
const zapNote = () => `Zap from ${identity.current()?.name || 'anon'}`;

// Spend hub = ROOM actions only. "Zap the speaker" is gated on stage occupancy; the
// picker/onPickAmount path is shared with the card's per-person zap.
const zapUI = createZapUI({
  toast: (m) => hud.toast(m),
  onZapSpeaker: () => {
    const g = stageSpeakerGroup();
    if (!g) return hud.toast('No one on stage to zap');
    const id = g.userData.identity;
    zapAvatar(id.pubkey, id.name); // for now single-speaker → direct; "which speaker" picker is later
  },
  onZapComment: () => openCompose(),   // spend hub → post a comment (costs a zap)
  onPickAmount: (pubkey, amountSats) => wallet.zap({ toPubkey: pubkey, amountSats, note: zapNote() }),
});

// The You menu is the wallet's home. connect() lives there; the balance also surfaces
// beside the Zap control (hud.showBalance) as a convenience readout.
async function connectWallet() {
  await wallet.connect();                 // REAL: NWC connect / WebLN.enable()
  hud.showBalance(true);
  hud.setBalance(wallet.getBalance());
  openYou();                              // refresh the You menu now that a wallet is connected
}

// The one "zap a person" entry: connect-gated (prompts the You menu), then
// input-appropriate.
function zapAvatar(pubkey, name) {
  if (!wallet.isConnected()) { hud.toast('Connect a wallet to zap'); openYou(); return; }
  if (renderer.xr.isPresenting) wallet.zap({ toPubkey: pubkey, amountSats: DEFAULT_ZAP, note: zapNote() }); // VR quick-zap
  else zapUI.openPicker({ pubkey, name });                                                                  // flat/mobile picker
}

// The stage's current speaker: the first avatar standing on the main-stage disc. Null
// when the stage is empty (→ "Zap the speaker" dims). SEAM: a multi-speaker panel
// would return the chosen one here.
const _spk = new THREE.Vector3();
function stageSpeakerGroup() {
  for (const g of pickables()) {
    g.getWorldPosition(_spk);
    if (Math.hypot(_spk.x - STAGE_POS.x, _spk.z - STAGE_POS.z) <= STAGE_RADIUS && _spk.y > 0.5) return g;
  }
  return null;
}

// The You / Stage / Instructions / Booking homes. Live actions route to the identity +
// wallet services; not-yet buttons dim + toast inside menus.js (no fake behaviour).
const menus = createMenus({
  toast: (m) => hud.toast(m),
  onSignIn: async () => { await signInFlow(); openYou(); },
  onSwitch: async () => { identity.logout(); await signInFlow(); openYou(); },
  onLogout: () => { identity.logout(); hud.setSignedIn(null); openYou(); },
  onConnectWallet: () => connectWallet(),
  onBookOpen: () => openBooking(),
  onActivity: () => openActivity(),
});

// ── Comment board (Phase 3, mock) ────────────────────────────────────────────────
// Two in-world screens (right = live feed, left = top-zapped wall) render the `board`
// service; posting and boosting both charge through the `wallet` service and record
// the result on 'confirmed'. Text entry is the DOM compose form (VR keyboard is v2).
const BOARD_PUBKEY = identity.pubkeyFromSeed('board-house'); // sink for comment-post payments (mock)
const BOOST_SATS = 21;                                        // one zap-to-boost
const commentBoard = createCommentBoard(scene, { board });
const boardUI = createBoardUI({
  toast: (m) => hud.toast(m),
  onPost: (text, amountSats) => postComment(text, amountSats),
});

function openCompose() {
  const me = identity.current();
  if (!me) { hud.toast('Sign in to comment'); openYou(); return; }
  if (!wallet.isConnected()) { hud.toast('Connect a wallet to comment'); openYou(); return; }
  closeAllMenus();
  boardUI.openCompose({ cost: BOOST_SATS });
}
function openActivity() {
  const me = identity.current();
  closeAllMenus();
  boardUI.openActivity(me ? board.byPubkey(me.pubkey) : []);
}

// Post a comment: charge the zap, and only on 'confirmed' record it to the board.
async function postComment(text, amountSats) {
  const me = identity.current();
  if (!me) { hud.toast('Sign in to comment'); openYou(); return; }
  boardUI.closeCompose();
  const res = await wallet.zap({ toPubkey: BOARD_PUBKEY, amountSats, note: `comment: ${text.slice(0, 40)}` });
  if (res.state === 'confirmed') board.post({ pubkey: me.pubkey, text }); // charge-on-confirmed
  // a 'failed' zap surfaces via the global wallet.onZap toast; nothing is posted.
}

// Zap-to-boost: zapping a comment pays its author AND raises it on the top wall.
async function boostComment(commentId) {
  const c = board.get(commentId);
  if (!c) return;
  if (!wallet.isConnected()) { hud.toast('Connect a wallet to zap'); openYou(); return; }
  const res = await wallet.zap({ toPubkey: c.pubkey, amountSats: BOOST_SATS, note: 'boost' });
  if (res.state === 'confirmed') board.boost(commentId, BOOST_SATS);
}
// Zap whoever is currently selected (ring/card target) — the Y binding + hub action.
function zapSelected() {
  const g = selectedGroup;
  if (!g) { if (!renderer.xr.isPresenting) hud.toast('Tap someone to zap them'); return; }
  const id = g.userData.identity;
  zapAvatar(id.pubkey, id.name);
}
// The on-screen avatar group for a pubkey (target for the in-world zap burst).
function groupForPubkey(pubkey) {
  return pickables().find((g) => g.userData?.identity?.pubkey === pubkey) || null;
}

// Feedback for EVERY zap state. The in-world burst works in VR; toasts are the
// flat/mobile addition. Balance only changes on 'confirmed' (the wallet owns it).
wallet.onZap((e) => {
  if (e.state === 'pending') {
    if (!renderer.xr.isPresenting) hud.toast(`Zapping ${fmtSats(e.amountSats)} sats…`);
  } else if (e.state === 'confirmed') {
    hud.setBalance(wallet.getBalance());
    zapFx.spawn(groupForPubkey(e.toPubkey), e.amountSats); // ⚡ burst on the zapped avatar
    if (!renderer.xr.isPresenting) hud.toast(`⚡ Sent ${fmtSats(e.amountSats)} sats`);
  } else if (e.state === 'failed') {
    if (!renderer.xr.isPresenting) hud.toast(`Zap failed — ${e.reason}`);
  }
});

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
hud.onRequest(() => hud.toast('Not available yet'));
hud.onZap(openSpendHub);                                 // control-bar Zap → spend-menu hub
hud.onVoice(toggleVoice);                                 // control-bar mic == game verb B

// Game verb B → the Listen/Speak mic toggle. Named so the VR B button and the desktop
// B key route to the exact same action as the control-bar button (cross-input parity).
async function toggleVoice() {
  if (hud.el.btnVoice.disabled) return;                  // ignore re-entrant taps/keys
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
}

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
const _prevPos = new THREE.Vector3().copy(rig.position); // for the movement vignette

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

  // Comfort vignette (flat, opt-in): fade in while actually moving (> ~0.2 m/s).
  if (comfort.get('vignette') && !renderer.xr.isPresenting) {
    hud.setVignetteLevel(rig.position.distanceTo(_prevPos) > dt * 0.2 ? 1 : 0);
  }
  _prevPos.copy(rig.position);

  zapFx.update(dt);           // in-world zap bursts (no-op when none are active)
  commentBoard.update(dt);    // live-feed scroll + sticky top-wall refresh

  renderer.render(scene, camera);
});
