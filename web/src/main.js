import * as THREE from 'three';
import { config } from './config.js';
import { buildScene } from './room/scene.js';
import { zones, buildZoneScenery, accessClamp, PARK, PARK_PENS } from './zones/zones.js';
import { createFlock } from './room/flock.js';
import { createCoaster } from './ride/coaster.js';
import { tickets } from './tickets/tickets.js';
import { createTicketUI } from './ui/ticketUI.js';
import { createEventPrompt } from './ui/eventPrompt.js';
import { STAGE_POS, STAGE_RADIUS, STAGE_TOP_Y, QUESTIONER_POS, constrainPosition, boundaryFor } from './room/zones.js';
import { seedPlaceholders, createPlayerBody, applyIdentity, MIN_BODY_GAP, setCigarette, tickCigarette, makeHand, playEmote, tickEmote, EMOTES, makeLocalFresnelMaterial } from './room/avatars.js';
import { createZoneAudio } from './audio/zoneAudio.js';
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
import { createSessionUI } from './ui/sessionUI.js';
import { mintCode, redeemCode } from './session/session.js';
import { createBoardUI } from './ui/boardUI.js';
import { board } from './board/board.js';
import { createCommentBoard } from './room/commentBoard.js';
import { createMicUI } from './ui/micUI.js';
import { queue } from './queue/queue.js';
import { createQueuePanel } from './room/queuePanel.js';
import { createXrMenu } from './room/xrMenu.js';
import { createBookingUI } from './ui/bookingUI.js';
import { createSpeakerHub } from './ui/speakerHub.js';
import { booking } from './booking/booking.js';
import { wallet } from './wallet/wallet.js';
import { createZapEffects } from './room/zapEffect.js';
import { Voice } from './voice/livekit.js';
import { createPresence } from './state/presence.js';
import { createEarnings } from './state/earnings.js';
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
const { scene, userFloor, setARMode, update: updateScene } = buildScene();
// Social zones behind the audience (Smoking Area + Networking): floor markings, glowing
// signage, and plaques. Freestanding props → they stay visible in AR (not part of the shell).
buildZoneScenery(scene);
// 🦩 Nostrich Park (4.10): the procedural flock + the roller coaster. Both animate on the frame
// loop; the coaster async-loads the owner GLBs (placeholder carts until they land). onReturn
// releases any local rider from their seat.
const flock = createFlock(scene, { center: { x: PARK.cx, z: PARK.cz }, pens: PARK_PENS, count: 8 });
const coaster = createCoaster(scene, {
  nCarts: 4,
  onDepart: () => { hud.toast('🎢 And… away we go!'); },
  onReturn: () => endRide(),
});
// Static ambiance capsules; positions feed avatar separation; groups get identities.
const seeded = seedPlaceholders(scene);
const staticBodies = seeded.map((s) => s.position);

// ── Identity (Phase 2, mock) ──────────────────────────────────────────────────────
// Every avatar is keyed by a pubkey (mock-derived from its stable id) → profile →
// keyface + name, all via the identity service (the single source of identity). The
// real swap (nostr-tools + NIP-07) lives behind this same service — callers unchanged.
function identifyAvatar(group, seedId, badge = null, speaker = false) {
  const pubkey = identity.pubkeyFromSeed(seedId);
  identity.getProfile(pubkey).then((profile) => {
    applyIdentity(group, { pubkey, npub: identity.npubFromPubkey(pubkey), ...profile, badge, speaker });
  });
}
// Ambiance crowd — showcase the label marks: a plain SPEAKER (🎙 only), a Supporter gem, and a
// Patron who also booked (gem + 🎙, i.e. combinable).
const SEED_BADGE = [null, 'supporter', 'patron'];
const SEED_SPEAKER = [true, false, true];
seeded.forEach((s, i) => identifyAvatar(s.group, `seed-${i}`, SEED_BADGE[i % SEED_BADGE.length], SEED_SPEAKER[i % SEED_SPEAKER.length]));

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
let xrMenu = null; // the in-world VR/AR menu (created near the frame loop); null in flat-only load
let _seatIdx = null; // which stage chair the local player sits in (panels, 4.5), or null

const { rig, update: updateLocomotion, setFreeLook, setMoveInput, jump, resetFlatView } =
  createLocomotion(camera, renderer.domElement, {
    spawn,
    isMobile,
    // who is dynamic now (4.5): stage access + backstage follow the LIVE speaker-pass state
    // (URL ?role=speaker OR a granted co-speaker pass), so panels/backstage just work.
    constrain: (x, z) => constrainPosition(
      { role: config.role, isNextUp: who.isNextUp, speaker: tickets.speakerPass(), backstage: config.role === 'speaker' || !!tickets.flags().backstageAccess },
      x, z, arActive,
    ),
    onBoundary: () => { boundaryGlow = 1; }, // soft edge stop + glow, no snap-back
    // Pointer lock dropped on its own (e.g. Esc) → reflect it in the toggle + hide
    // the ESC hint, so the button and pointer-lock state never get out of sync.
    onFreeLookEnd: () => { freeLookOn = false; hud.setFreeLook(false); hud.showFreeLookHint(false); },
    // Cross-input parity: these verbs are also bound on the desktop keys (inside
    // locomotion) — here we route them to this game's actions. One handler per verb,
    // shared by VR buttons + keyboard, so nothing is improvised per-platform.
    // X / Esc·M → Pause/Menu. In immersive the in-world panel is the menu (DOM is
    // invisible there); in flat it's the DOM pause menu. Same concept, two renderers.
    onMenu: () => { if (renderer.xr.isPresenting && xrMenu) xrMenu.toggle(); else toggleMenu(); },
    onGrab: () => doGrab(),           // grip / E-hold·right-click → grab (inert seam)
    onVerbB: () => toggleVoice(),     // B / B-key  → game verb: toggle mic (Listen/Speak)
    onVerbY: () => zapSelected(),     // Y / Y-key  → game verb: zap the selected avatar
    onEmote: (kind) => doEmote(kind), // 1–4 keys   → emotes (4.8), typing-guarded in locomotion
  });
scene.add(rig);

// Local player body (capsule), parented to the rig so it moves + turns with us. Hidden while
// we're a ghost / invisible (embodiment is a paid ticket perk — see refreshEmbodiment).
const LOCAL_BODY_COLOR = who.role === 'speaker' ? 0xf7931a : 0x4cc2ff;
const localBody = createPlayerBody(LOCAL_BODY_COLOR);
rig.add(localBody);

// Local-body comfort (4.9): in immersive VR/AR, glancing down at your own opaque pill blocks
// the floor. Fade the LOCAL body to a faint hint in immersive only — depthWrite:false so being
// inside the capsule doesn't z-fight / double-layer, and so the transparent body never occludes
// your (opaque) hand mitts or the floor. Purely a local render tweak: peers still receive the
// full opaque body (this is NOT presence state, and unrelated to "go invisible"). Flat unchanged.
// In immersive, swap the local body to a fresnel SHELL (4.13 #7): near-invisible core, glowing
// light-blue rim, floor visible through the middle. Flat keeps the solid capsule. Hands are a
// separate mesh (opaque) and unaffected; peers keep the opaque body (this is a local render swap).
const _localBodyMesh = localBody.getObjectByName('body');
const _localBodySolidMat = _localBodyMesh?.material;
const _localBodyFresnelMat = _localBodyMesh ? makeLocalFresnelMaterial(LOCAL_BODY_COLOR) : null;
function setLocalBodyImmersive(on) {
  if (!_localBodyMesh) return;
  _localBodyMesh.material = on && _localBodyFresnelMat ? _localBodyFresnelMat : _localBodySolidMat;
}

// ── HUD ─────────────────────────────────────────────────────────────────────────
const hud = createHud();
hud.setRoom(config.room);
stageState.role = config.role;

// Social-zone SEAM → HUD locality indicator. This is the ONLY consumer for now; the
// ticketing + audio-zone slices will subscribe here too (mic on entering Smoking, etc.).
// Zone pill — the zone + its live occupancy with a compact badge breakdown.
function zonePillInfo(zone) {
  if (!zone) return null;
  const o = zones.occupancy(zone.id);
  const badges = [o.patron && `◆${o.patron}`, o.supporter && `◇${o.supporter}`, o.speaker && `🎙${o.speaker}`].filter(Boolean).join(' ');
  return { text: `${zone.emoji} ${zone.name} · ${o.count} inside${badges ? ` (${badges})` : ''}`, hue: zone.hue };
}
zones.onChange((zone) => hud.setZone(zonePillInfo(zone)));

// Bounced at a zone door (no access flag). Prompt ONCE per approach: ghosts → the ticket
// chooser; ticketed-without-access (Basic) → the credits access purchase for that door.
let _lastBlocked = null;
function onZoneBlocked(zn) {
  if (_lastBlocked === zn.id) return;   // already prompted this approach — don't nag every frame
  _lastBlocked = zn.id;
  // Backstage is speakers-only and NOT purchasable — money can't buy the green room.
  if (zn.id === 'backstage') { hud.toast('🎬 Backstage — speakers only'); return; }
  // Smoking with access but mic not yet granted → the "your mic turns ON" confirm (4.4),
  // NOT a purchase. Accepting unblocks entry; declining leaves the soft bounce in place.
  if (zn.id === 'smoking' && tickets.flags().smokingAccess && !micOk.has('smoking')) { askMicConfirm('smoking'); return; }
  if (tickets.tier() === 'ghost') {
    hud.toast(`${zn.emoji} ${zn.name} needs a ticket`);
    openTicketChooser();
  } else {
    const price = tickets.accessPrice(zn.accessKind);
    hud.toast(`${zn.name} — ${price} credits to enter`);
    ticketUI.openAccess({ kind: zn.accessKind, price });
  }
}

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
  return afterSignedIn(me);
}
// Headset login: adopt an identity handed over from another device (redeemed code). Same
// post-sign-in effect as signInFlow — the wallet loads THIS pubkey's persisted balance, so
// the headset can zap/post/queue as that person. (Balance itself is per-browser localStorage
// today; true cross-device balance sync arrives when the wallet goes real server-side.)
function adoptFlow(profile) {
  const me = identity.adopt(profile);
  return afterSignedIn(me);
}
// Shared "we are now signed in as `me`" side-effects (HUD chip + wallet + tickets).
function afterSignedIn(me) {
  wallet.activate(me.pubkey);     // load THIS identity's persisted local balance
  tickets.activate(me.pubkey);    // load THIS identity's persisted tier + embodiment
  hud.setSignedIn({ name: me.name, faceUrl: drawKeyface(me.pubkey, 64).toDataURL() });
  hud.showBalance(true);
  hud.setBalance(wallet.getBalance());
  refreshEmbodiment();            // body/ghost-indicator/counts follow the loaded tier
  // (4.11 #1) Mark the RUNNING event as already-seen so signing in / redeeming a code mid-event
  // doesn't pop the transition prompt — that fires only on a genuine boundary (event CHANGE).
  _promptedEventId = booking.currentEvent()?.id ?? null;
  return me;
}

// ── Embodiment (ghost vs paid) ────────────────────────────────────────────────────
// Embodied = holds a paid ticket AND is currently visible. Ghosts (free/un-ticketed) and
// paid users who "went invisible" are NOT embodied: no local body, no presence broadcast
// (peers don't render them), counted as listeners not participants.
// Embodied = a MEMBER (paid tier OR speaker pass) who is currently visible. tickets.visible()
// already folds in the speaker pass, so a ghost who books a slot embodies too.
function embodied() { return tickets.visible(); }

const BASE_EMBODIED = seeded.length;   // seeded ambiance bodies
const BASE_LISTENERS = 32;             // seeded plausible ghost/listener count (mock)
let lastParticipantCount = 1;
function refreshCounts(pc = lastParticipantCount) {
  lastParticipantCount = pc;
  const remoteEmbodied = Math.max(0, pc - 1);                 // LiveKit peers (minus us)
  hud.setPresence(BASE_EMBODIED + remoteEmbodied + (embodied() ? 1 : 0),
                  BASE_LISTENERS + (embodied() ? 0 : 1));
}
// Apply the current embodiment state everywhere it shows: local body, ghost indicator, counts.
function refreshEmbodiment() {
  localBody.visible = embodied();
  // A true ghost holds neither an attendee tier nor a speaker pass; a member who toggled off is
  // "invisible", not a ghost.
  const trueGhost = tickets.tier() === 'ghost' && !tickets.speakerPass();
  hud.setGhost(embodied() ? null
    : trueGhost ? '👻 observing as a ghost' : '👻 invisible — observing');
  refreshCounts();
  // Feed the local player's marks into zone occupancy, then refresh the in-world counters + pill.
  const f = tickets.flags();
  zones.setLocalBadge(f.badge, f.speaker);
  zones.refreshOccupancy();
  if (zones.current()) hud.setZone(zonePillInfo(zones.current()));
}
// Pass lifetime: valid through its event + this grace (stay embodied through dead air).
const INTER_EVENT_GRACE_MIN = 10;
const GRACE_MS = INTER_EVENT_GRACE_MIN * 60_000;
const WELCOME_ZAP = 210; // one-tap welcome zap to the event speaker (everyone, incl. ghosts)
// The event a ticket purchase applies to (running, else next), and its speaker pot.
const eventForTicket = () => booking.activeOrNextEvent();
const currentPot = () => { const e = eventForTicket(); return e ? tickets.speakerPot(e.id) : 0; };
// Tier/embodiment can change from anywhere (buy, toggle, access) — reflect it once, here.
tickets.onChange(() => {
  refreshEmbodiment();
  hud.setBalance(wallet.getBalance());
  const e = eventForTicket();
  menus.setSpeakerPot(currentPot(), e?.title || '');
});
refreshEmbodiment(); // initial: signed-out visitor is a ghost (no body, listener count)
// Sign-in gate for anything that spends sats or posts content. Signed out → prompt sign
// in (the You menu, where Sign in is the primary button) and stop.
function requireSignedIn(what = 'do that') {
  if (identity.current()) return true;
  hud.toast(`Sign in first to ${what}`);
  openYou();
  return false;
}
// Ticket gate — everything that spends/posts/queues/books now needs a paid ticket, not just a
// sign-in: signed out → prompt sign-in; signed-in ghost → prompt the ticket chooser. Extends
// the requireSignedIn pattern (the ghost is the new "not yet allowed" state).
function requireTicket(what = 'do that') {
  if (!identity.current()) { hud.toast(`Sign in first to ${what}`); openYou(); return false; }
  // A MEMBER — paid attendee tier OR a speaker pass (booked a slot) — is allowed. Only a true
  // ghost is prompted to get a ticket. (A speaker with 0 credits tops up like anyone to zap.)
  if (tickets.tier() === 'ghost' && !tickets.speakerPass()) { hud.toast(`Get a ticket to ${what}`); openTicketChooser(); return false; }
  return true;
}
function openTicketChooser() {
  closeAllMenus();
  const ev = eventForTicket();
  ticketUI.openChooser({ eventTitle: ev?.title, prices: ev?.prices || null, custom: !!ev?.prices });
}
hud.onSignIn(() => openYou());   // "You" control-bar chip → You menu
hud.onStage(() => openStage());  // "Stage" control-bar button → Stage menu

// Accidental-zap protection: "Boost posts by tap" preference (default ON). Persisted PER
// PUBKEY when signed in, else a device-level default. Applies ONLY to board-comment
// tap-boost; avatar zaps and everything else are unaffected.
const BOOST_PREF = (pk) => `xrstage:boostByTap:${pk || '_device'}`;
function boostByTap() {
  const pk = identity.current()?.pubkey;
  try {
    const v = localStorage.getItem(BOOST_PREF(pk));
    if (v !== null) return v === '1';
    const dev = localStorage.getItem(BOOST_PREF(null));
    return dev !== null ? dev === '1' : true; // default ON
  } catch { return true; }
}
function setBoostByTap(on) {
  try { localStorage.setItem(BOOST_PREF(identity.current()?.pubkey), on ? '1' : '0'); } catch { /* private mode */ }
}
// The single gated tap→boost entry (desktop click · mobile tap · VR select all funnel
// here). OFF = inert: no zap, no error.
function tapBoost(commentId, worldPoint) {
  if (!boostByTap()) return;
  boostComment(commentId, worldPoint);
}

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
    setLocalBodyImmersive(mode !== 'flat');      // 4.9: faint self-body in immersive, solid in flat
    xrMenu?.close();                             // (4.13 #1) never carry the in-world panel across a mode change
    if (mode === 'flat') resetFlatView();        // clear residual XR camera roll/offset on return to flat
    if (mode === 'flat' && !isMobile) hud.flashLockHint(); // brief reminder on return
    if (mode !== 'flat') hud.showFreeLookHint(false);
    updateArMenuBtn();                            // phone-AR ☰ visibility (4.11 #3)
  },
  // AR = shell-off: passthrough look + per-prop collision (arActive flips the clamp).
  onARMode: (on) => { arActive = on; setARMode(on); updateArMenuBtn(); },
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
function closeAllMenus() {
  hud.showMenu(false); zapUI.closeAll(); menus.closeAll();
  boardUI.closeAll(); micUI.close(); bookingUI.close(); speakerHub.close();
  sessionUI.closeAll();
}
function openYou() {
  closeAllMenus();
  const me = identity.current();
  menus.openYou({
    signedIn: !!me,
    name: me?.name || null,
    faceUrl: me ? drawKeyface(me.pubkey, 64).toDataURL() : null,
    balance: wallet.getBalance(),
    tier: tickets.tier(),                 // 'ghost' | 'basic' | 'supporter' | 'patron'
    tierLabel: tickets.TIERS[tickets.tier()]?.label,
    visible: tickets.visible(),
    badge: tickets.flags().badge,
    speaker: tickets.speakerPass(),       // 🎙 Speaker pass (from booking a slot)
    lastSplit: tickets.lastSplit(),       // "where your sats went" (null for pre-3.14 records)
    held: heldEventSummary(),             // which event this ticket/pass is for, + until when
  });
}
// The event this identity holds a ticket/pass for, formatted for the You menu.
function heldEventSummary() {
  const id = tickets.heldEventId();
  const ev = id && booking.event(id);
  if (!ev) return null;
  const until = new Date(ev.endsAt + GRACE_MS);
  return { title: ev.title, until: `${fmtClock(ev.endsAt)} +${INTER_EVENT_GRACE_MIN}m grace (${fmtClock(until.getTime())})` };
}
async function openStage() { closeAllMenus(); menus.openStage(await stageData()); }
function openInstructions() { closeAllMenus(); menus.openInstructions(); }
function openBooking() {
  if (!requireSignedIn('book a slot')) return;
  closeAllMenus();
  bookingUI.open({ slots: booking.slots(), myPubkey: identity.current().pubkey });
}
async function openSpeakerHub() {
  const myEvent = booking.mine()[0];
  if (!myEvent) return; // gated in the Stage menu, but guard anyway
  closeAllMenus();
  const me = identity.current();
  const totalMin = Math.max(1, Math.round((myEvent.endsAt - myEvent.startsAt) / 60000));
  const nSpk = myEvent.speakers.length || 1;
  speakerHub.open({
    mySlot: myEvent, entries: await hubEntries(), criteria: queue.criteria(),
    event: myEvent, isOwner: !!me && me.pubkey === myEvent.ownerPubkey,
    earnings: { pot: tickets.speakerPot(myEvent.id), zaps: earnings.receivedFor(myEvent.id), yourMin: Math.round(totalMin / nSpk), totalMin },
    defaults: { basic: tickets.TIERS.basic.price, supporter: tickets.TIERS.supporter.price, patron: tickets.TIERS.patron.price },
  });
}
function openSpendHub() { if (!requireSignedIn('spend sats')) return; closeAllMenus(); zapUI.openHub({ speakerAvailable: !!stageSpeakerGroup(), mic: micState(), boostByTap: boostByTap() }); }

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

// Speaker earnings — direct-zap tally per event (4.7). Broadcasts my confirmed zaps so
// recipients can accumulate their incoming totals (mock wallet.onZap is sender-local).
const earnings = createEarnings(voice, wallet, {
  getMyPubkey: () => identity.current()?.pubkey || null,
  getEventId: () => (booking.currentEvent() || booking.nextEvent())?.id || null,
});

// Presence exists from the start so avatar separation (incl. static props) is always
// active. The heartbeat send/receive only carries data once voice connects (sendData
// no-ops with no room), so nothing leaks before the user joins.
// getPose returns null while we're a ghost / invisible → presence skips the heartbeat, so
// peers never render a body for us (we're a listener, not a participant).
//
// In immersive modes we broadcast the HEAD's world pose, not the rig's: room-scale/AR
// walking moves the head within the rig, so peers must see us where our head actually is
// (matching the local body, which also follows the head — see followBody). y stays at the
// rig's floor level so remote bodies stand on the ground rather than float at head height.
const _headWorld = new THREE.Vector3();
const _headQuat = new THREE.Quaternion();
const _headEuler = new THREE.Euler(0, 0, 0, 'YXZ');
const presence = createPresence(voice, scene, () => {
  if (!embodied()) return null;
  const zone = zones.current()?.id || null;   // broadcast our zone → real occupancy + zone audio
  const seatIdx = _seatIdx;                    // broadcast our stage chair → peers see who sits where
  if (renderer.xr.isPresenting) {
    camera.getWorldPosition(_headWorld);
    _headEuler.setFromQuaternion(camera.getWorldQuaternion(_headQuat), 'YXZ');
    return { x: _headWorld.x, y: rig.position.y, z: _headWorld.z, yaw: _headEuler.y, zone, seatIdx, hands: localHands() };
  }
  return { x: rig.position.x, y: rig.position.y, z: rig.position.z, yaw: rig.rotation.y, zone, seatIdx };
}, staticBodies, {
  // Each remote peer gets a mock identity (face + name) keyed by its presence id.
  // REAL: presence carries the peer's pubkey; this becomes getProfile(pubkey).
  onAvatarSpawn: (id, group) => identifyAvatar(group, id),
});

// ── Zone audio (Prompt 4.4) ──────────────────────────────────────────────────────
// Proximity voice + zone isolation, layered over the stage voice via zoneAudio. It
// reads presence peers/positions and drives per-participant gain; enter/leave is fed
// from the zone seam below. Nothing here touches the stage speaker/listener path.
const zoneAudio = createZoneAudio({
  voice,
  myIdentity: config.identity,
  getLocalPos: () => ({ x: rig.position.x, z: rig.position.z }),
  getPeers: () => presence.peers(),
  toast: (m) => hud.toast(m),
  onTalkRequest: ({ from, name }) => onIncomingTalk(from, name),
});
// Zone enter/leave → publish/unpublish + gain scope. (Smoking entry is already gated on
// the mic confirm via accessClamp below, so by the time this fires consent is given.)
zones.onChange((zone) => {
  const id = zone?.id || null;
  // Open-mic zones (Smoking / Backstage) publish only AFTER the mic-ON confirm. Smoking is
  // confirmed at its access edge (below); Backstage confirms on entry (no pre-entry gate).
  if (id === 'smoking' || id === 'backstage') {
    if (micOk.has(id)) zoneAudio.setZone(id);
    else { zoneAudio.setZone(null); askMicConfirm(id); }   // silent until they confirm
  } else zoneAudio.setZone(id);                             // networking / plaza
});

// Networking incoming talk request → accept/decline. Flat: a DOM dialog; VR: the in-world
// menu Requests page (badge + toast here). Either side can decline/end.
const _talkReq = {
  root: document.getElementById('talk-request'), body: document.getElementById('tr-body'),
  accept: document.getElementById('tr-accept'), decline: document.getElementById('tr-decline'),
};
let _pendingReq = null;
function onIncomingTalk(fromId, name) {
  _pendingReq = fromId;
  if (renderer.xr.isPresenting) { hud.toast(`🤝 ${name || 'Someone'} wants to talk — open the menu`); return; }
  _talkReq.body.textContent = `${name || 'Someone'} in Networking wants to talk. Open a talk link?`;
  _talkReq.root.hidden = false;
}
const _resolveReq = (accept) => { _talkReq.root.hidden = true; if (_pendingReq) (accept ? zoneAudio.acceptTalk : zoneAudio.declineTalk)(_pendingReq); _pendingReq = null; };
_talkReq.accept.addEventListener('click', () => _resolveReq(true));
_talkReq.decline.addEventListener('click', () => _resolveReq(false));
_talkReq.root.addEventListener('click', (e) => { if (e.target === _talkReq.root) _resolveReq(false); });

// Open-mic zone confirm — the "your mic turns ON in here" moment, shared by Smoking (shown
// at its access edge) and Backstage (shown on entry). Continue grants the mic within this
// click gesture; Not-now leaves the soft bounce / keeps you silent.
const _micConfirm = {
  root: document.getElementById('zone-confirm'), title: document.getElementById('zc-title'),
  body: document.getElementById('zc-body'), yes: document.getElementById('zc-yes'), no: document.getElementById('zc-no'),
};
const micOk = new Set();          // zones whose mic-ON confirm has been accepted this session
let _pendingMicZone = null;
const ZONE_MIC_COPY = {
  smoking:   { title: '🚬 Smoking Area', body: 'Your mic turns ON in here so people nearby can hear you — and you hear them, louder the closer you stand. Continue?' },
  backstage: { title: '🎬 Backstage', body: 'Backstage is an open mic — the other panelists here hear you (proximity), and you still hear the stage so you know when you’re up. Turn your mic on?' },
};
function askMicConfirm(zoneId) {
  if (micOk.has(zoneId)) return;
  _pendingMicZone = zoneId;
  const c = ZONE_MIC_COPY[zoneId] || ZONE_MIC_COPY.smoking;
  _micConfirm.title.textContent = c.title; _micConfirm.body.textContent = c.body;
  _micConfirm.root.hidden = false;
}
_micConfirm.yes.addEventListener('click', async () => {
  _micConfirm.root.hidden = true;
  const z = _pendingMicZone; _pendingMicZone = null;
  if (z) micOk.add(z);
  _lastBlocked = null;                 // let the pill fire on the legitimate entry
  try { if (!voice.isConnected) { await voice.connect(); await voice.setListening(true); } }
  catch { /* connect failure already surfaced; entry allowed, mic silent until a server publish grant */ }
  if (z === 'backstage' && zones.current()?.id === 'backstage') zoneAudio.setZone('backstage'); // already inside → publish now
});
const _closeMic = () => { _micConfirm.root.hidden = true; _pendingMicZone = null; };
_micConfirm.no.addEventListener('click', _closeMic);
_micConfirm.root.addEventListener('click', (e) => { if (e.target === _micConfirm.root) _closeMic(); });

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
// Networking: ask a live person (both in Networking) for a mutual talk link (4.4).
function onAskTalk() {
  const pid = selectedGroup?.userData.pid;
  if (!pid) return hud.toast('Can only ask live people to talk');
  if (!requireSignedIn('talk')) return;
  zoneAudio.requestTalk(pid, identity.current()?.name);
}
// The selected peer's live zone (from presence), for the "Ask to talk" gate.
const peerZoneOf = (group) => (group?.userData.pid ? presence.peers().find((p) => p.id === group.userData.pid)?.zone : null) || null;

const card = createProfileCard({ onVisit, onFollow, onZap, onAskTalk, onClose: deselect });

function selectAvatar(group, profile) {
  group.add(selectionRing);              // ring follows the avatar
  selectionRing.position.set(0, 0.06, 0);
  selectedGroup = group;
  // Ask-to-talk shows only when I AND the picked live peer are both in Networking.
  const here = zones.current()?.id;   // Ask-to-talk in the permission zones: Networking + 🦩 Park
  const canAskTalk = !!identity.current() && (here === 'networking' || here === 'park') && peerZoneOf(group) === here;
  card.open(profile, { following: identity.isFollowing(profile.pubkey), canAskTalk });
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
  // The in-world menu is MODAL while open: it owns the pointer, so a select goes to the
  // panel (button under the laser) and nothing behind it is pickable.
  if (xrMenu && xrMenu.isOpen()) {
    const mh = raycaster.intersectObjects(xrMenu.targets(), false)[0];
    if (mh) xrMenu.pressWorld(mh.point);
    return;
  }
  const targets = pickables().concat(commentBoard.pickables()).concat(_chairs.map((c) => c.group)).concat(coaster.seatPads()).concat([coaster.rideButton()].filter(Boolean)).concat(flock.pickTargets()).concat(feedOffer.visible ? [feedOffer] : []);
  const hits = raycaster.intersectObjects(targets, true);
  for (const h of hits) {
    let o = h.object;
    while (o) {
      if (o.userData && o.userData.feedAction) { confirmFeed(); return; }                          // 🦩 Feed offer → pay + feed
      if (o.userData && o.userData.birdId) { offerFeed(o.userData.birdId); return; }               // 🦩 select an ostrich → offer
      if (o.userData && o.userData.rideButton) { boardRideButton(); return; }                     // RIDE post → next free seat
      if (o.userData && o.userData.rideSeat) { boardRide(o.userData.rideSeat); return; }          // board the coaster (direct seat)
      if (o.userData && o.userData.chairIdx != null) { toggleSeat(o.userData.chairIdx); return; } // sit/stand
      if (o.userData && o.userData.commentId) { tapBoost(o.userData.commentId, h.point.clone()); return; }
      if (o.userData && o.userData.identity) {
        if (o === selectedGroup) deselect();                 // same avatar → close
        else selectAvatar(o, o.userData.identity);           // replaces any open card
        return;
      }
      o = o.parent;
    }
  }
  deselect();                                                // empty space → close
  hideFeedOffer();                                           // 🦩 and dismiss any bird offer
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

// Per-viewer LIVE-board scrolling (flat + mobile). CLIENT-LOCAL — never shared, available
// to everyone incl. signed-out viewers. A pointer that STARTS on the LIVE panel is owned
// here (capture phase + stopImmediatePropagation), so it scrolls the feed instead of
// rotating the camera. Vertical drag past DRAG_THRESH_PX = scroll (no boost); a clean tap
// = boost (via the boost-by-tap gate) or the "● live" chip = snap to live. Mouse wheel
// over the panel also scrolls. Non-panel pointers fall through to look / tap-pick as before.
{
  const dom = renderer.domElement;
  const _sv = new THREE.Vector2();
  const DRAG_THRESH_PX = 8;   // beyond this a pointer is a scroll, not a tap
  const STEP_PX = 64;         // px of vertical finger/mouse travel per one comment (≈ a card's on-screen height → ~1:1)
  const WHEEL_STEP_PX = 100;  // px of wheel travel per one comment (≈ one classic mouse notch)
  const WHEEL_LINE_PX = 33;   // deltaMode=1 (lines) → px (~3 lines per notch ≈ one comment)
  let drag = null, wheelAccum = 0;

  // Parse a pointer against the LIVE panel → { kind, cardId, point } or null. Priority when a
  // ray passes through several targets (they can sort out of visual order at grazing angles):
  // scrollbar THUMB > "● live" CHIP > scrollbar TRACK > comment CARD > bare panel backdrop.
  const rayParse = (e) => {
    const r = dom.getBoundingClientRect();
    _sv.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(_sv, camera);
    const hits = raycaster.intersectObjects(commentBoard.liveTargets().concat(commentBoard.scrollTargets()), true);
    if (!hits.length) return null;                 // not the LIVE panel
    for (const h of hits) {                         // explicit controls win over cards/backdrop
      const u = h.object.userData || {};
      if (u.scrollThumb) return { kind: 'thumb', cardId: null, point: h.point.clone() };
      if (u.liveChip)    return { kind: 'chip',  cardId: null, point: h.point.clone() };
      if (u.scrollTrack) return { kind: 'track', cardId: null, point: h.point.clone() };
    }
    for (const h of hits) if (h.object.userData?.commentId) return { kind: 'card', cardId: h.object.userData.commentId, point: h.point.clone() };
    return { kind: 'panel', cardId: null, point: hits[0].point.clone() };
  };

  dom.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || document.pointerLockElement === dom) return;
    const p = rayParse(e);
    if (!p) return;                                // not the LIVE panel → normal handlers
    e.stopImmediatePropagation();                  // own it: no camera look, no tap-pick
    drag = { id: e.pointerId, startY: e.clientY, lastY: e.clientY, moved: false, kind: p.kind, cardId: p.cardId, point: p.point };
  }, true);

  dom.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    e.stopImmediatePropagation();
    if (Math.abs(e.clientY - drag.startY) > DRAG_THRESH_PX) drag.moved = true;
    if (drag.kind === 'thumb' || drag.kind === 'track') {
      if (drag.moved) { const p = rayParse(e); if (p) commentBoard.scrubToWorld(p.point); } // grab & slide, 1:1
    } else if (drag.moved) {
      commentBoard.scrollBy((e.clientY - drag.lastY) / STEP_PX); // drag down → older (~card-height per comment)
    }
    drag.lastY = e.clientY;
  }, true);

  const endDrag = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    e.stopImmediatePropagation();
    if (!drag.moved) {                             // a clean tap (no drag travel)
      if (drag.kind === 'chip') commentBoard.snapLive();
      else if (drag.kind === 'track') commentBoard.pageAtWorld(drag.point); // page one window toward the tap
      else if (drag.kind === 'card' && drag.cardId) tapBoost(drag.cardId, drag.point);
    }
    drag = null;
  };
  dom.addEventListener('pointerup', endDrag, true);
  dom.addEventListener('pointercancel', endDrag, true);

  // Wheel: normalize deltaMode (pixels/lines/pages), accumulate, and emit AT MOST one comment
  // per event — so a mouse notch = one comment and a trackpad's flood of large deltas (or an
  // inertial fling) can't blow through the whole history in a frame.
  dom.addEventListener('wheel', (e) => {
    if (!rayParse(e)) return;
    e.preventDefault();
    let dy = e.deltaY;
    if (e.deltaMode === 1) dy *= WHEEL_LINE_PX;         // lines → px
    else if (e.deltaMode === 2) dy *= dom.clientHeight; // pages → px
    if (Math.sign(dy) !== Math.sign(wheelAccum)) wheelAccum = 0; // direction reversal → drop stale accum
    wheelAccum += dy;
    let steps = Math.trunc(wheelAccum / WHEEL_STEP_PX);
    if (!steps) return;
    wheelAccum -= steps * WHEEL_STEP_PX;                // consume (overflow beyond the clamp is dropped, not queued)
    steps = Math.max(-1, Math.min(1, steps));           // ≤ 1 comment per wheel event
    commentBoard.scrollBy(-steps);                       // wheel up (dy<0) → older (offset+)
  }, { passive: false });
}

// XR: the controller (or AR screen-tap) select ray feeds the SAME pickFromRaycaster
// as the desktop click — one "select avatar" path for every input. Each controller
// gets a visible aiming ray so the user can point.
const xrControllers = []; // for the VR board-scroll (frame loop reads the right stick)
{
  const _m = new THREE.Matrix4();
  for (let i = 0; i < 2; i++) {
    const controller = renderer.xr.getController(i); // target-ray space
    rig.add(controller); // controllers live in the rig's (reference) space
    xrControllers.push(controller);

    // Aiming ray — hidden until a controller connects in an XR session (so it never
    // shows as a stray line in flat mode, and is skipped for AR's screen-tap input).
    const ray = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -5)]),
      new THREE.LineBasicMaterial({ color: 0xf7931a, transparent: true, opacity: 0.6 }),
    );
    ray.visible = false;
    controller.add(ray);
    // Tracked-hand proxy (4.8): a mitt parented to the controller → auto-follows its pose.
    // Shown only in immersive while embodied (toggled in updateLocalHands). Peers see it via
    // the broadcast hand transforms; this is the local first-person view of your own hands.
    const mitt = makeHand(who.role === 'speaker' ? 0xf7931a : 0x4cc2ff);
    mitt.visible = false;
    controller.add(mitt);
    controller.userData.mitt = mitt;
    // TEMP 4.13 #1 · X-DBG — an in-world label per controller showing handedness + which gamepad
    // buttons are down, so the owner can confirm on-device what the X button reports. STRIP after.
    {
      const dc = document.createElement('canvas'); dc.width = 512; dc.height = 132;
      const dtex = new THREE.CanvasTexture(dc);
      const dspr = new THREE.Sprite(new THREE.SpriteMaterial({ map: dtex, transparent: true, depthTest: false }));
      dspr.scale.set(0.42, 0.108, 1); dspr.position.set(0, 0.14, -0.16); dspr.renderOrder = 999;
      controller.add(dspr);
      controller.userData.xdbg = { ctx: dc.getContext('2d'), tex: dtex };
    }
    controller.addEventListener('connected', (e) => {
      ray.visible = e.data?.targetRayMode !== 'screen';
      controller.userData.handedness = e.data?.handedness;   // for the VR scroll
      controller.userData.inputSource = e.data;
      updateArMenuBtn();                                     // a real controller → hide the phone-AR ☰
    });
    controller.addEventListener('disconnected', () => { ray.visible = false; controller.userData.inputSource = null; updateArMenuBtn(); });
    // Grip held = scrub the scrollbar thumb (VR thumb-drag); tracked for updateVRBoardScroll.
    controller.addEventListener('squeezestart', () => { controller.userData.gripping = true; });
    controller.addEventListener('squeezeend', () => { controller.userData.gripping = false; });

    controller.addEventListener('select', () => {
      _m.identity().extractRotation(controller.matrixWorld);
      raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
      raycaster.ray.direction.set(0, 0, -1).applyMatrix4(_m).normalize();
      pulse(0.3, 30);          // select/fire haptic (opt-in via the comfort menu)
      pickFromRaycaster();
    });
  }
}

// ── Tracked hands + emotes (4.8) ─────────────────────────────────────────────────
// HAND ENCODING: each hand = position(3) + quaternion(4) RELATIVE TO THE BODY ROOT, so a peer
// reconstructs them as children of the avatar group (which sits at the head pose). 14 floats,
// quantised to mm/1e-3 → ~100 bytes added to the heartbeat when in immersive; absent otherwise.
const _hp = new THREE.Vector3(), _hq = new THREE.Quaternion(), _bq = new THREE.Quaternion();
const q3 = (n) => Math.round(n * 1000) / 1000;
function localHands() {
  if (!renderer.xr.isPresenting || !embodied()) return null;
  const out = []; let any = false;
  for (let i = 0; i < 2; i++) {
    const c = xrControllers[i], src = c?.userData.inputSource;
    if (c && src && src.targetRayMode !== 'screen') {
      c.getWorldPosition(_hp); localBody.worldToLocal(_hp);          // → body-relative position
      localBody.getWorldQuaternion(_bq).invert().multiply(c.getWorldQuaternion(_hq)); // → body-relative quat
      out.push(q3(_hp.x), q3(_hp.y), q3(_hp.z), q3(_bq.x), q3(_bq.y), q3(_bq.z), q3(_bq.w));
      any = true;
    } else out.push(0, 0, 0, 0, 0, 0, 1);   // absent hand → identity (harmless; hidden peer-side if all absent)
  }
  return any ? out : null;
}
// Show/hide the local mitts each frame (immersive + embodied + a real controller pointer).
function updateLocalHands() {
  const on = renderer.xr.isPresenting && embodied();
  for (const c of xrControllers) {
    const m = c.userData.mitt; if (!m) continue;
    const src = c.userData.inputSource;
    m.visible = on && !!src && src.targetRayMode !== 'screen';
  }
}

// EMOTES: procedural body animation + a floating emoji burst, played locally and on peers.
// Gated on EMBODIMENT (ghosts have no body); rate-limited to 1/sec per participant.
let _lastEmoteAt = -1e9;
function doEmote(kind) {
  if (!EMOTES[kind]) return;
  if (!embodied()) return hud.toast('Emotes need a body — get a ticket');
  const nowMs = performance.now();
  if (nowMs - _lastEmoteAt < 1000) return;   // 1/sec spam guard
  _lastEmoteAt = nowMs;
  playEmote(localBody, kind);
  zapFx.emote(localBody, EMOTES[kind].emoji);
  voice.sendData({ t: 'emote', kind }, { reliable: true });
}
// Inbound emote → play it on the sender's avatar (+ burst). Rate-limited per sender.
const _peerEmoteAt = new Map();
voice.onData((id, msg) => {
  if (!msg || msg.t !== 'emote' || !EMOTES[msg.kind]) return;
  const nowMs = performance.now();
  if (nowMs - (_peerEmoteAt.get(id) || -1e9) < 900) return;   // ignore spam from a peer
  _peerEmoteAt.set(id, nowMs);
  const g = presence.peers().find((p) => p.id === id)?.group;
  if (!g) return;
  playEmote(g, msg.kind);
  zapFx.emote(g, EMOTES[msg.kind].emoji);
});
// Emote row (flat/mobile) → the same doEmote path as the 1–4 keys.
for (const b of document.querySelectorAll('#emote-row .emote-btn')) {
  b.addEventListener('click', () => doEmote(b.dataset.emote));
}

// Phone-AR ☰ (4.11 #3): visible only in AR with NO controller input source (phone AR uses the
// DOM overlay + screen-tap). On Quest AR the controllers connect → X works and the ☰ hides.
const _arMenuBtn = document.getElementById('ar-menu-btn');
_arMenuBtn.addEventListener('click', () => xrMenu?.toggle());
function updateArMenuBtn() {
  // Count only REAL controllers (tracked-pointer) — a phone-AR screen tap is a transient
  // 'screen' input source and must NOT hide the ☰ (it's how you press the panel).
  const hasController = xrControllers.some((c) => c.userData.inputSource && c.userData.inputSource.targetRayMode !== 'screen');
  _arMenuBtn.hidden = !(arActive && renderer.xr.isPresenting && !hasController);
}

// ── Wallet + zap (Phase 3, mock) ─────────────────────────────────────────────────
// The wallet service is the ONE source of balance + zaps, SEPARATE from identity
// (signing ≠ paying). All three zap seams — the profile-card Zap, the control-bar Zap
// (spend hub), and the Y binding — funnel through ONE zap-avatar flow: flat/mobile
// opens the amount picker, VR quick-zaps a default. Real Lightning (NWC/LNbits) swaps
// in behind wallet.js without touching any caller here.
const DEFAULT_ZAP = 21; // sats — the VR quick-zap amount (no DOM picker in immersive)
const zapFx = createZapEffects(scene);   // scene = where world-space comment flings are added
const BOARD_TOP_Y = 2.7 + 3.6 / 2;       // world Y of a board's top edge (centre 2.7, height 3.6)
const fmtSats = (n) => n.toLocaleString('en-US');
const zapNote = () => `Zap from ${identity.current()?.name || 'anon'}`;

// Spend hub = ROOM actions only. "Zap the speaker" is gated on stage occupancy; the
// picker/onPickAmount path is shared with the card's per-person zap.
const zapUI = createZapUI({
  toast: (m) => hud.toast(m),
  onZapSpeaker: () => zapSpeakerFlow(),   // single-speaker → direct; panel → which-speaker picker (4.5)
  onZapComment: () => openCompose(),   // spend hub → post a comment (costs a zap)
  onTakeMic: () => openMicForm(),      // spend hub → join / top up the paid mic queue
  onToggleBoost: () => { setBoostByTap(!boostByTap()); zapUI.setBoost(boostByTap()); }, // accidental-zap toggle
  onPickAmount: (pubkey, amountSats) => wallet.zap({ toPubkey: pubkey, amountSats, note: zapNote() }),
});

// The wallet's home is the You menu. Top up = credit the LOCAL per-identity balance
// (mock: +DEFAULT_TOPUP; real: pay an invoice). The balance also surfaces beside the Zap
// control (hud.showBalance) as a convenience readout.
function topUpWallet() {
  if (!requireSignedIn('top up')) return;
  wallet.topUp();
  hud.showBalance(true);
  hud.setBalance(wallet.getBalance());
  hud.toast(`Topped up +${wallet.DEFAULT_TOPUP.toLocaleString('en-US')} sats`);
  openYou();                              // refresh the You menu with the new balance
}

// The one "zap a person" entry: sign-in-gated (insufficient balance is handled by the
// zap-failed path, which prompts Top up), then input-appropriate.
function zapAvatar(pubkey, name) {
  if (!requireSignedIn('zap')) return;
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

// Cross-device headset login (mint on phone/desktop, redeem on the headset). The redeem
// path adopts the identity via adoptFlow — just another way to arrive at "signed in".
// SEAM: in immersive mode the DOM is invisible, so v1 is "redeem in flat mode, then enter
// VR" (noted in the redeem hint). The natural first IN-WORLD-UI piece is a 6-digit VR keypad
// on the sign-in surface (a numeric pad is far simpler than a full text keyboard) — feeding
// this same redeemCode()/adoptFlow() path. Not built in this slice.
const sessionUI = createSessionUI({
  toast: (m) => hud.toast(m),
  onMint: () => mintCode(identity.current()),        // public profile → { code, expiresAt }
  onRedeem: (code) => redeemCode(code),              // code → public profile (throws on bad)
  onAdopted: (profile) => { adoptFlow(profile); openYou(); }, // become them; refresh the You menu
});

// Event-transition prompt (shown by the transition engine below). Get a ticket · one-tap
// Welcome zap (everyone) · Continue as ghost (dismiss → lapse, credits kept).
const eventPrompt = createEventPrompt({
  onGetTicket: () => openTicketChooser(),
  onWelcomeZap: () => welcomeZap(),
  onContinueGhost: () => continueAsGhost(),
});
// Welcome zap — one-tap 210 sats to the current/next event's speaker. UN-GATED beyond sign-in +
// balance (ghosts can zap); doesn't change your status. Reuses the normal zap flow (bursts too).
function welcomeZap() {
  if (!requireSignedIn('zap the speaker')) return;
  const ev = booking.currentEvent() || booking.nextEvent();
  if (!ev) return hud.toast('No event to zap right now');
  const spks = ev.speakers.slice(0, booking.MAX_SPEAKERS);
  const zapOne = (pk) => { wallet.zap({ toPubkey: pk, amountSats: WELCOME_ZAP, note: `Welcome zap · ${ev.title}` }); hud.toast(`⚡ Welcome zap — ${WELCOME_ZAP} to @${pk.slice(0, 8)}`); };
  if (spks.length > 1) {   // panel → name all, zap the picked one
    const names = spks.map((pk) => `@${pk.slice(0, 8)}`).join(', ');
    hud.toast(`Panel: ${names} — pick who to welcome-zap`);
    if (renderer.xr.isPresenting) return xrMenu?.openSpeakers?.();
    return openPickerFlat('⚡ Welcome-zap which speaker?', spks.map((pk) => ({ pubkey: pk, label: `@${pk.slice(0, 8)}` })), zapOne);
  }
  zapOne(spks[0] || ev.ownerPubkey);
}
// Continue as ghost — an embodied non-holder lapses now (credits + identity + history kept).
function continueAsGhost() {
  if (tickets.visible()) { tickets.lapseToGhost(); hud.toast('Continuing as a ghost — your credits are kept'); }
}

// Ticket chooser + access micro-purchase. buy() is the ENTRY payment (mock external) that,
// on confirm, credits the wallet and embodies you (tickets.onChange re-embodies + updates HUD).
// The ONE ticket-purchase flow (event-scoped), shared by the DOM tier chooser and the
// in-world VR/AR menu so neither duplicates the service logic. `notSignedIn` lets each
// caller route the not-signed-in case its own way (DOM → You menu, VR → keypad page).
async function buyTicket(tier, { notSignedIn } = {}) {
  if (!identity.current()) { hud.toast('Sign in first to buy a ticket'); notSignedIn && notSignedIn(); return { state: 'failed', reason: 'not signed in' }; }
  const ev = eventForTicket();
  if (!ev) { hud.toast('No event to buy into right now'); return { state: 'failed', reason: 'no event' }; }
  eventPrompt.close();                                 // buying satisfies the transition prompt
  const res = await tickets.buy(tier, ev.id, ev.prices?.[tier]); // charge the event's (maybe custom) price
  if (res.state === 'confirmed') {
    hud.setBalance(wallet.getBalance());
    hud.toast(`You're in — ${tickets.TIERS[tier].label} · ${ev.title} · +${res.credits.toLocaleString('en-US')} credits`);
  }
  return res;
}
const ticketUI = createTicketUI({
  toast: (m) => hud.toast(m),
  tiers: tickets.TIERS,
  split: (t, price) => tickets.split(t, price),   // per-event price override (4.7) when the chooser passes one
  currentTier: () => tickets.tier(),
  getBalance: () => wallet.getBalance(),
  onBuy: async (tier) => {
    const res = await buyTicket(tier, { notSignedIn: openYou });
    if (res.state === 'confirmed') openYou();           // refresh the DOM You menu
    return res;
  },
  onAccess: async (kind) => {
    const res = tickets.purchaseAccess(kind);          // spends credits → sets the access flag
    if (res.ok) { hud.setBalance(wallet.getBalance()); hud.toast(`${zoneKindLabel(kind)} access unlocked — walk in`); }
    return res;
  },
});
const zoneKindLabel = (k) => (k === 'smoking' ? 'Smoking Area' : k === 'networking' ? 'Networking' : k);

// The You / Stage / Instructions / Booking homes. Live actions route to the identity +
// wallet services; not-yet buttons dim + toast inside menus.js (no fake behaviour).
const menus = createMenus({
  toast: (m) => hud.toast(m),
  onSignIn: async () => { await signInFlow(); openYou(); },
  onSwitch: async () => { identity.logout(); wallet.deactivate(); tickets.deactivate(); refreshEmbodiment(); await signInFlow(); openYou(); },
  onLogout: () => {
    identity.logout(); wallet.deactivate(); tickets.deactivate(); // → ghost; persisted per-pubkey records stay
    hud.setSignedIn(null); hud.showBalance(false);    // no balance shown while signed out
    refreshEmbodiment();                              // back to ghost: no body, listener count
    openYou();
  },
  onTopUp: () => topUpWallet(),
  onGetTicket: () => openTicketChooser(),                     // event-scoped tier chooser
  onToggleVisible: () => {                            // paid → go invisible / re-embody
    const now = tickets.setVisible(!tickets.visible());
    hud.toast(now ? 'Visible — others see you' : 'Invisible — observing as a ghost');
    openYou();
  },
  onLoginHeadset: () => { menus.closeYou(); sessionUI.openMint(); },  // signed-in → mint a code
  onEnterCode: () => { menus.closeYou(); sessionUI.openRedeem(); },   // signed-out → redeem a code
  onBookOpen: () => openBooking(),
  onSpeakerHubOpen: () => openSpeakerHub(),
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
  if (!requireTicket('comment')) return;
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
  if (!requireTicket('comment')) return;
  const me = identity.current();
  boardUI.closeCompose();
  const res = await wallet.zap({ toPubkey: BOARD_PUBKEY, amountSats, note: `comment: ${text.slice(0, 40)}` });
  if (res.state === 'confirmed') board.post({ pubkey: me.pubkey, text }); // charge-on-confirmed
  // a 'failed' zap surfaces via the global wallet.onZap toast; nothing is posted.
}

// Zap-to-boost: zapping a comment pays its author AND raises it on the top wall. The ⚡
// burst is flung off the card itself (worldPoint from the raycast hit) — out toward the
// panel's near side (left panel → left, right panel → right) then up over the top.
async function boostComment(commentId, worldPoint) {
  const c = board.get(commentId);
  if (!c) return;
  if (!requireSignedIn('zap')) return;
  const res = await wallet.zap({ toPubkey: c.pubkey, amountSats: BOOST_SATS, note: 'boost' });
  if (res.state === 'confirmed') {
    board.boost(commentId, BOOST_SATS);
    if (worldPoint) {
      zapFx.fling({ position: worldPoint, side: worldPoint.x < 0 ? 'left' : 'right', topY: BOARD_TOP_Y, amount: BOOST_SATS });
    }
  }
}

// ── Mic queue (Phase 3.4, mock) ──────────────────────────────────────────────────
// The paid "take the mic" queue: pay a zap to line up at the pedestal/floor mic (the
// questioner spot, NOT the main stage). The `queue` service is the single source of
// queue state + ordering — Money is implemented; Activity/Manual are recognized
// parameters for a later Speaker-hub toggle. Charging runs through the wallet
// (charge-on-confirmed, no refunds). Granting speak rights at the mic is a later slice.
const queuePanel = createQueuePanel(scene, { queue });
const micUI = createMicUI({
  toast: (m) => hud.toast(m),
  onJoin: (amount, pitch) => joinQueue(amount, pitch),
  onTopUp: (amount) => topUpQueue(amount),
});

// A snapshot of my queue standing, for the spend-hub button + the mic form.
function micState() {
  const me = identity.current();
  const e = me ? queue.entry(me.pubkey) : null;
  return {
    inQueue: !!e, position: me ? queue.position(me.pubkey) : null,
    count: queue.count(), total: e?.totalSats || 0, pitch: e?.pitch || '',
  };
}
function openMicForm() {
  if (!requireTicket('take the mic')) return;
  closeAllMenus();
  micUI.open(micState());
}
async function joinQueue(amountSats, pitch) {
  if (!requireTicket('take the mic')) return;
  const me = identity.current();
  micUI.close();
  const res = await queue.join({ pubkey: me.pubkey, amountSats, pitch });
  if (res.state === 'confirmed') hud.toast(`In the mic queue — you're #${queue.position(me.pubkey)} of ${queue.count()}`);
  // a 'failed' zap surfaces via the global wallet.onZap toast; nothing joins.
}
async function topUpQueue(amountSats) {
  if (!requireTicket('take the mic')) return;
  const me = identity.current();
  micUI.close();
  const res = await queue.topUp({ pubkey: me.pubkey, amountSats });
  if (res.state === 'confirmed') hud.toast(`Topped up — you're #${queue.position(me.pubkey)} of ${queue.count()}`);
}

// Live queue updates: the spend-hub button label, the open mic form, and the "you're
// up" cue (fires when queue.next() advances someone — the pedestal ring is driven by
// queuePanel; here we add the toast, and a personal one if it's you).
let _lastUp = null;
queue.onChange(() => {
  if (zapUI.isHubOpen()) zapUI.setMic(micState());
  micUI.setState(micState());
  refreshHub();                        // keep the Speaker-hub queue list + toggle live
  const up = queue.current();
  if (up && up !== _lastUp) {
    _lastUp = up;
    const me = identity.current();
    hud.toast(me && up.pubkey === me.pubkey ? "You're up — head to the mic ⚡" : `@${up.pubkey.slice(0, 8)} is up at the mic`);
  }
});

// ── Booking (Phase 3.5, mock) ────────────────────────────────────────────────────
// Book a stage slot: pay a zap to hold a time to speak. The `booking` service is the
// single source of slot state; charging runs through the wallet (charge-on-confirmed,
// NO refunds). A booking unlocks the Speaker hub.
const bookingUI = createBookingUI({
  toast: (m) => hud.toast(m),
  onBook: (slotId, title, slots, description) => bookSlot(slotId, title, slots, description),
});
const speakerHub = createSpeakerHub({
  toast: (m) => hud.toast(m),
  onCancelBooking: (slotId) => cancelBooking(slotId),
  onSetCriteria: (c) => { queue.setCriteria(c); refreshHub(); }, // re-ranks the pedestal panel too (queue.onChange)
  onPick: (pubkey) => queue.next(pubkey),                        // Manual: advance THIS entrant → you're-up cue
  onNext: () => queue.next(),                                    // advance by current criteria → you're-up cue
  onAddCoSpeaker: () => addCoSpeakerFlow(),                      // panels: pick a present participant → co-speaker
  onEditEvent: (fields) => editMyEvent(fields),                 // 4.7: title + description (organizer)
  onSetPrices: (prices) => setMyEventPrices(prices),            // 4.7: per-event tier prices (organizer)
});

// Organizer-only event edits (4.7). Owner check on the local booking event, then mutate +
// broadcast so every client's schedule/chooser converges (mirrors the co-speaker signal).
function editMyEvent({ title, description } = {}) {
  const ev = booking.mine()[0];
  if (!ev) return;
  if (identity.current()?.pubkey !== ev.ownerPubkey) return hud.toast('Only the organizer can edit');
  booking.editEvent(ev.id, { title, description });
  voice.sendData({ t: 'eventedit', eventId: ev.id, title, description }, { reliable: true });
  hud.toast('Event updated');
  openSpeakerHub();
  if (!document.getElementById('stage-menu').hidden) openStage();
}
function setMyEventPrices(prices) {
  const ev = booking.mine()[0];
  if (!ev) return;
  if (identity.current()?.pubkey !== ev.ownerPubkey) return hud.toast('Only the organizer can edit');
  booking.setPrices(ev.id, prices);
  voice.sendData({ t: 'eventprices', eventId: ev.id, prices: booking.event(ev.id).prices }, { reliable: true });
  hud.toast(prices ? 'Ticket prices updated (new purchases)' : 'Prices reset to defaults');
  openSpeakerHub();
}
// Inbound event edits/prices from the organizer → converge the local booking + open surfaces.
voice.onData((_id, msg) => {
  if (!msg) return;
  if (msg.t === 'eventedit') {
    booking.editEvent(msg.eventId, { title: msg.title, description: msg.description });
    if (!document.getElementById('stage-menu').hidden) openStage();
    if (speakerHub.isOpen()) openSpeakerHub();
  } else if (msg.t === 'eventprices') {
    booking.setPrices(msg.eventId, msg.prices);
  }
});

// Entrant rows for the hub queue list, with names resolved via identity (async).
async function hubEntries() {
  return Promise.all(queue.list().map(async (e) => ({
    pubkey: e.pubkey, totalSats: e.totalSats, pitch: e.pitch,
    name: (await identity.getProfile(e.pubkey)).name,
  })));
}
async function refreshHub() {
  if (speakerHub.isOpen()) speakerHub.setQueue({ entries: await hubEntries(), criteria: queue.criteria() });
}
function cancelBooking(slotId) {
  booking.cancel(slotId);                 // frees the slot, NO refund
  speakerHub.close();                     // the hub re-dims (no booking)
  hud.toast('Booking cancelled — slot freed (no refund)');
  if (!document.getElementById('stage-menu').hidden) openStage(); // refresh the Stage menu if open
}

async function bookSlot(slotId, title, slots = 1, description = '') {
  if (!requireSignedIn('book a slot')) return;
  const me = identity.current();
  const res = await booking.book({ slotId, title, slots, description });
  if (res.state === 'confirmed') {
    // Booking IS the speaker's ticket for THIS event → the pass grant (in booking) embodies +
    // adds 🎙 via tickets.onChange. Confirm it here.
    hud.toast(`🎙 Event booked — "${res.event.title}" · Speaker pass active`);
    bookingUI.render({ slots: booking.slots(), myPubkey: me.pubkey }); // reflect "Yours"
  } else if (res.reason === 'slot taken') {
    hud.toast('One of those slots was just taken');
    bookingUI.render({ slots: booking.slots(), myPubkey: me.pubkey });
  }
  // other failures: nothing books.
}

// Schedule data for the Stage menu — a list of EVENTS (title · organizer · time), resolving
// organizer names via identity (async, on demand). Marks the currently-running event.
const fmtClock = (ms) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
async function stageData() {
  const evs = booking.events();
  const cur = booking.currentEvent();
  const events = await Promise.all(evs.map(async (e) => ({
    id: e.id, time: fmtClock(e.startsAt), title: e.title, description: e.description, organizer: (await identity.getProfile(e.ownerPubkey)).name,
  })));
  const e = eventForTicket();
  return { events, currentId: cur?.id || null, hasBooking: booking.mine().length > 0, pot: currentPot(), potTitle: e?.title || '' };
}

// Keep the Stage menu live (schedule + hub gate) when a booking changes while it's open;
// and if my booking disappears while the Speaker hub is open, re-dim (close) it.
booking.onChange(() => {
  if (!document.getElementById('stage-menu').hidden) openStage();
  if (speakerHub.isOpen() && !booking.mine().length) speakerHub.close();
});

// ── Event-transition engine ───────────────────────────────────────────────────────────
// Watches booking's event boundaries (on the mock clock). Drives two things:
//   (a) LAPSE — when my held event has ended + grace passed → lapse to ghost (credits kept).
//   (b) PROMPT — when a new/different event is running that I don't hold → show the transition
//       prompt ONCE per event (to embodied non-holders AND signed-in ghosts).
// Seeded to the CURRENT event at load so a RELOAD mid-event doesn't re-prompt (single-source
// seen-set, shared by the DOM prompt AND the in-world Event page). A genuine boundary (event id
// change) is the only thing that re-arms it. afterSignedIn re-marks it on sign-in/redeem.
let _promptedEventId = booking.currentEvent()?.id ?? null;
async function eventTick() {
  if (!identity.current()) return;                 // signed-out → nothing to scope
  const t = booking.now();
  const cur = booking.currentEvent();
  // (a) grace expiry
  const heldId = tickets.heldEventId();
  if (tickets.visible() && heldId) {
    const ev = booking.event(heldId);
    if (!ev || t >= ev.endsAt + GRACE_MS) {
      tickets.lapseToGhost();
      hud.toast('Your event wrapped — back to ghost (credits kept)');
    }
  }
  // (b) new/different current event I don't hold → prompt once
  if (cur && !tickets.holdsFor(cur.id)) {
    // Don't fire the transition prompt while the player is on the coaster (4.13 #1) — a panel that
    // popped mid-ride is exactly what orphaned before. The once-per-event gate still lets it show
    // after they're back at the station.
    if (_promptedEventId !== cur.id && !eventPrompt.isOpen() && _rideSeat == null) {
      _promptedEventId = cur.id;
      const name = (await identity.getProfile(cur.speakers[0] || cur.ownerPubkey)).name;
      // (4.11 #2) Immersive → the in-world Event page (VR/AR parity); flat → the DOM prompt. Same
      // once-per-event gate (_promptedEventId), same underlying handlers.
      if (renderer.xr.isPresenting && xrMenu) {
        xrMenu.openEvent({ title: cur.title, speaker: name });
      } else {
        closeAllMenus();
        eventPrompt.open({ title: cur.title, speaker: name, description: cur.description });
      }
    }
  } else {
    if (cur && tickets.holdsFor(cur.id)) eventPrompt.close(); // I hold the current event → no prompt
    if (!cur) _promptedEventId = null;                        // dead air → allow the next event to prompt
  }
}
booking.onChange(eventTick);
tickets.onChange(eventTick);
setInterval(eventTick, 4000);
eventTick();

// DEV time-skip (flagged) — advance the mock clock to verify event boundaries without waiting.
// e.g. window.__skip(11) skips 11 minutes. No UI; console/handle only.
window.__skip = (min = INTER_EVENT_GRACE_MIN) => { booking.__skip(min); console.info(`[dev] skipped ${min} min → now`, new Date(booking.now()).toLocaleTimeString()); };
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
    if (e.note !== 'boost') zapFx.spawn(groupForPubkey(e.toPubkey), e.amountSats); // avatar zap → burst at the person; boosts fling from the card instead
    if (!renderer.xr.isPresenting) hud.toast(`⚡ Sent ${fmtSats(e.amountSats)} sats`);
  } else if (e.state === 'failed') {
    if (!renderer.xr.isPresenting) {
      if (e.reason === 'insufficient balance') { hud.toast('Not enough sats — top up your wallet'); openYou(); }
      else hud.toast(`Zap failed — ${e.reason}`);
    }
  }
});

onStateChange((s) => {
  refreshCounts(s.participantCount); // embodied · listeners (ghost) split
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

// VR board scroll (the chosen VR input): aim the RIGHT controller at the LIVE panel and
// push the right stick UP/DOWN (axis Y) to scroll. Turn is the right stick's X axis, so
// it's unaffected — no turn-suppression needed, and right-stick Y is otherwise unused in
// this game. Device-only (headless can't enter immersive). Grip-drag was the alternative;
// this is lighter and reuses a free axis.
const _vrM = new THREE.Matrix4();
const VR_SCROLL_RATE = 5; // comments/sec at full stick deflection (eased target, device feel)
function updateVRBoardScroll(dt) {
  if (!renderer.xr.isPresenting) return;
  for (const ctrl of xrControllers) {
    if (ctrl.userData.handedness !== 'right') continue;
    _vrM.identity().extractRotation(ctrl.matrixWorld);
    raycaster.ray.origin.setFromMatrixPosition(ctrl.matrixWorld);
    raycaster.ray.direction.set(0, 0, -1).applyMatrix4(_vrM).normalize();
    raycaster.camera = camera;

    // Grip held + aim at the thumb (or track) = scrub the scrollbar to that point (1:1).
    if (ctrl.userData.gripping) {
      const hit = raycaster.intersectObjects(commentBoard.scrollTargets(), true)[0]
               || raycaster.intersectObjects(commentBoard.liveTargets(), true)[0];
      if (hit) commentBoard.scrubToWorld(hit.point);
      continue;                                        // grip owns the input; skip stick scroll
    }
    // Otherwise: aim at the LIVE panel + right-stick Y scrolls (eased).
    const y = ctrl.userData.inputSource?.gamepad?.axes?.[3] ?? 0;
    if (Math.abs(y) < 0.2) continue;                   // deadzone
    if (raycaster.intersectObjects(commentBoard.liveTargets(), true).length) {
      commentBoard.scrollBy(-y * VR_SCROLL_RATE * dt); // stick up (y<0) → older comments
    }
  }
}

// ── Body-follows-head (immersive) ────────────────────────────────────────────────
// Physically stepping in VR/AR moves the HEAD within the rig (thumbstick locomotion
// still moves the rig itself). Each frame we pin the local body's XZ + yaw under the
// head so it never gets left behind — the WebXR head pose lands in `camera` as a
// rig-LOCAL offset (local-floor reference), the same space `localBody` (a rig child)
// lives in, so we copy it straight across. In AR the dark user-floor disc tracks the
// head's WORLD XZ too, keeping the footing centred on the player.
//
// Zone clamp/detection stay on the RIG (the clampable thing — you can't physically stop
// a walking user): if you step past a boundary the rig clamps + the edge glows, but the
// head (and thus the body, and what peers see) may briefly overshoot the line. Flat mode
// keeps the body at the rig origin.
function followBody() {
  if (renderer.xr.isPresenting) {
    localBody.position.x = camera.position.x;
    localBody.position.z = camera.position.z;
    _headEuler.setFromQuaternion(camera.quaternion, 'YXZ');
    localBody.rotation.y = _headEuler.y;
    if (arActive) {
      camera.getWorldPosition(_headWorld);
      userFloor.position.x = _headWorld.x;
      userFloor.position.z = _headWorld.z;
    }
  } else if (localBody.position.x || localBody.position.z || localBody.rotation.y) {
    localBody.position.x = 0;
    localBody.position.z = 0;
    localBody.rotation.y = 0;
  }
}

// ── In-world VR/AR menu (Prompt 4.2) ─────────────────────────────────────────────
// X opens a laser-clickable 3D panel that RENDERS OVER the existing service flows (no
// new service logic). One instance; shown only in immersive. Sign-in is the 6-digit
// keypad page (mint still happens on phone/desktop → redeemCode/adoptFlow). SEAM: the
// event-transition prompt stays DOM-only for now — a future in-world page can host it.
xrMenu = createXrMenu(scene, {
  camera,
  renderer,                                             // for the live XR head pose at open
  actions: {
    exit: () => xrCtl?.enter('screen'),                 // session.end → sessionend restores flat
    buyTicket: (tier) => buyTicket(tier),               // panel gates sign-in before calling
    topUp: () => { wallet.topUp(); hud.showBalance(true); hud.setBalance(wallet.getBalance()); hud.toast(`Topped up +${fmtSats(wallet.DEFAULT_TOPUP)} sats`); },
    redeem: async (code) => { const p = await redeemCode(code); adoptFlow(p); return p; }, // headset sign-in
    toggleBoost: () => { setBoostByTap(!boostByTap()); zapUI.setBoost(boostByTap()); },
    setComfort: (key, on) => comfort.set(key, on),
    toggleVoice: () => toggleVoice(),
    zapSpeaker: () => zapSpeakerFlow(),                 // panel → in-world Speakers page
    zapPickedSpeaker: (pk) => zapAvatar(pk, `@${pk.slice(0, 8)}`),
    acceptTalk: (id) => zoneAudio.acceptTalk(id),      // Networking talk-request accept (VR)
    declineTalk: (id) => zoneAudio.declineTalk(id),
    emote: (kind) => doEmote(kind),                    // 4.8: emotes from the in-world menu
    welcomeZap: () => welcomeZap(),                    // 4.11: transition Event page → welcome zap
    continueGhost: () => continueAsGhost(),            // 4.11: transition Event page → dismiss + lapse
  },
  state: {
    signedIn: () => !!identity.current(),
    name: () => identity.current()?.name,
    balance: () => wallet.getBalance(),
    tier: () => tickets.tier(),
    tierLabel: () => tickets.TIERS[tickets.tier()]?.label,
    tiers: tickets.TIERS,
    split: (t) => tickets.split(t),
    eventTitle: () => eventForTicket()?.title,
    boostOn: () => boostByTap(),
    comfort: () => comfort.all(),
    comfortKeys: comfort.KEYS,
    voiceOn: () => active,
    voiceVerb: verb,
    speakerPresent: () => !!stageSpeakerGroup(),
    talkRequests: () => zoneAudio.pendingIncoming(),   // [{ id, name }] pending Networking asks
    emotes: () => Object.entries(EMOTES).map(([kind, e]) => ({ kind, emoji: e.emoji })), // 4.8 emote list
    zapSpeakers: () => currentEventSpeakers().map((pk) => ({ pubkey: pk, label: `@${pk.slice(0, 8)}` })), // panel picker rows
  },
});

// Per-frame while the menu is open: billboard it toward the head, and drive hover from
// whichever controller laser is on the panel (re-textures only when the hovered button
// changes — no per-frame canvas work). Screen-tap (AR phone) sources have no persistent
// ray, so they simply get no hover; the trigger/tap still presses via pickFromRaycaster.
const _menuM = new THREE.Matrix4();
function updateMenu() {
  if (!xrMenu.isOpen()) return;
  xrMenu.update();
  if (!renderer.xr.isPresenting) return;
  let hit = null;
  for (const ctrl of xrControllers) {
    const src = ctrl.userData.inputSource;
    if (!src || src.targetRayMode === 'screen') continue;
    _menuM.identity().extractRotation(ctrl.matrixWorld);
    raycaster.ray.origin.setFromMatrixPosition(ctrl.matrixWorld);
    raycaster.ray.direction.set(0, 0, -1).applyMatrix4(_menuM).normalize();
    raycaster.camera = camera;
    const h = raycaster.intersectObjects(xrMenu.targets(), false)[0];
    if (h) { hit = h.point; break; }
  }
  xrMenu.hoverAt(hit);
}

// TEMP 4.13 #1 · X-DBG — refresh each controller's in-world button-debug label. STRIP after the
// owner confirms the X binding on-device. buttons[4] = A (right) / X (left) per the input standard.
function updateXrButtonDebug() {
  if (!renderer.xr.isPresenting) return;
  for (const c of xrControllers) {
    const d = c.userData.xdbg; if (!d) continue;
    const src = c.userData.inputSource, gp = src?.gamepad;
    const hand = c.userData.handedness || src?.handedness || '?';
    const pressed = []; if (gp) gp.buttons.forEach((b, i) => { if (b.pressed || b.value > 0.5) pressed.push(i); });
    const xDown = !!(gp && gp.buttons[4] && (gp.buttons[4].pressed || gp.buttons[4].value > 0.5));
    const g = d.ctx; g.clearRect(0, 0, 512, 132);
    g.fillStyle = xDown ? 'rgba(247,147,26,0.92)' : 'rgba(11,13,19,0.82)'; g.fillRect(0, 0, 512, 132);
    g.textBaseline = 'top'; g.fillStyle = xDown ? '#0b0d13' : '#eceef5';
    g.font = '700 34px ui-monospace, Menlo, monospace';
    g.fillText(`${String(hand).toUpperCase()}  btn:[${pressed.join(',')}]`, 14, 12);
    g.font = '500 26px ui-monospace, Menlo, monospace';
    g.fillText(hand === 'left' ? 'X = buttons[4] → menu' : hand === 'right' ? 'A = buttons[4]' : '(no handedness)', 14, 60);
    if (xDown) { g.font = '700 30px ui-monospace, Menlo, monospace'; g.fillText('★ PRESSED', 14, 96); }
    d.tex.needsUpdate = true;
  }
}

// Lit cigarette on every Smoking occupant (local render, keyed to each peer's broadcast
// zone — no networking beyond presence). Idempotent per frame; puff ticks only in-zone.
function updateCigarettes(dt) {
  for (const p of presence.peers()) {
    const smoking = p.zone === 'smoking';
    setCigarette(p.group, smoking);
    if (smoking) tickCigarette(p.group, dt);
  }
}

// ── Panels: chairs + seating + which-speaker picker (4.5) ────────────────────────
// Chairs are cheap stage furniture (visible in AR — added to the scene, not the shell),
// spawned only when the current event is a PANEL (2+ speakers), auto-centred by count.
const CHAIR_SEAT_Y = 0.42, SEAT_DROP = 0.28;
function makeChair() {
  const g = new THREE.Group();
  const body = new THREE.MeshStandardMaterial({ color: 0x1b2130, roughness: 0.75, metalness: 0.1 });
  const accent = new THREE.MeshBasicMaterial({ color: 0xf7931a, transparent: true, opacity: 0.85 });
  const seat = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.08, 0.5), body); seat.position.y = CHAIR_SEAT_Y; g.add(seat);
  const back = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.08), body); back.position.set(0, CHAIR_SEAT_Y + 0.29, -0.21); g.add(back);
  const trim = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.045, 0.05), accent); trim.position.set(0, CHAIR_SEAT_Y + 0.52, -0.21); g.add(trim);
  for (const sx of [-0.2, 0.2]) for (const sz of [-0.2, 0.2]) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.028, CHAIR_SEAT_Y, 6), body);
    leg.position.set(sx, CHAIR_SEAT_Y / 2, sz); g.add(leg);
  }
  return g;
}
let _chairs = [];      // [{ group, x, z }]
let _chairKey = '';
function buildChairs(n) {
  for (const c of _chairs) { scene.remove(c.group); c.group.traverse((o) => { o.geometry?.dispose?.(); o.material?.dispose?.(); }); }
  _chairs = [];
  if (_seatIdx != null && _seatIdx >= n) _seatIdx = null;
  const spacing = 1.3, z = STAGE_POS.z + 0.7, x0 = STAGE_POS.x - (n - 1) * spacing / 2;
  for (let i = 0; i < n; i++) {
    const g = makeChair();
    const x = x0 + i * spacing;
    g.position.set(x, STAGE_TOP_Y, z);        // on the raised stage top, facing the audience (+z)
    g.userData.chairIdx = i;
    scene.add(g);
    _chairs.push({ group: g, x, z });
  }
}
function updateChairs() {
  const ev = booking.currentEvent();
  const n = ev && ev.speakers.length >= 2 ? Math.min(ev.speakers.length, booking.MAX_SPEAKERS) : 0;
  const key = `${ev?.id || ''}:${n}`;
  if (key !== _chairKey) { _chairKey = key; buildChairs(n); }
}

// Seat-snap v1 (no animation): walk to a chair + select → snap onto it (position + a seated
// drop, facing the audience) + broadcast seatIdx; select again OR walk off → stand.
const canSit = () => config.role === 'speaker' || tickets.speakerPass();
function toggleSeat(idx) {
  if (_seatIdx === idx) { _seatIdx = null; return; }
  if (!canSit()) return hud.toast('Only speakers sit on stage');
  const ch = _chairs[idx]; if (!ch) return;
  rig.position.set(ch.x, STAGE_TOP_Y, ch.z);
  rig.rotation.y = Math.PI;                    // face the audience
  _seatIdx = idx;
  hud.toast('Seated — select the chair again or walk off to stand');
}
function updateSeat() {
  if (_seatIdx == null) return;
  const ch = _chairs[_seatIdx];
  if (!ch) { _seatIdx = null; return; }
  if (Math.hypot(rig.position.x - ch.x, rig.position.z - ch.z) > 0.5) { _seatIdx = null; return; } // walked off → stand
  rig.position.y = STAGE_TOP_Y - SEAT_DROP;    // lowered onto the chair
}

// ── Nostrich Coaster ride (4.10) ─────────────────────────────────────────────────
// Walk up + select a seat → pay 210 credits (venue 100%) → snap onto it; a ~20s station
// countdown, then the run; the rig is ATTACHED to the seat (not simulated) so presence
// broadcasts the moving position → spectators watch you ride by. onReturn releases you.
const RIDE_FEE = 210;
let _rideSeat = null;
// The station RIDE post (4.13 #5): select = pay + seat-snap into the NEXT free seat. A second guest
// selecting takes the next one after that. Falls through to the same boardRide flow (fee, gating,
// countdown, seat attach) — no ambiguity about how to board.
function boardRideButton() {
  if (!coaster.boardable()) return hud.toast('🎢 The coaster is out on a run — wait for the station');
  const seat = coaster.nextFreeSeat();
  if (!seat) return hud.toast('🎢 Every seat is taken — catch the next run');
  boardRide(seat);
}
function boardRide(id) {
  if (!coaster.boardable()) return hud.toast('🎢 The coaster is out on a run — wait for the station');
  if (coaster.isOccupied(id)) return hud.toast('That seat is taken');
  if (!requireSignedIn('ride')) return;
  if (!embodied()) return hud.toast('Get a ticket to ride');
  const res = wallet.spend(RIDE_FEE, 'ride:coaster');
  if (!res.ok) return hud.toast(`Need ${RIDE_FEE} credits to ride`);
  tickets.recordVenue(RIDE_FEE);                 // fee via the credit rails → venue 100%
  hud.setBalance(wallet.getBalance());
  coaster.occupy(id, true);
  _rideSeat = id;
  xrMenu?.close();                               // (4.13 #1) the in-world panel never rides along
  coaster.beginBoarding();
  hud.toast('🎢 Seat booked — the Nostrich Coaster departs shortly');
  // SEAT-PAIR TALK-LINK (seam): the two seats in a cart should auto-link for the ride. It needs
  // the neighbour's presence (peers don't broadcast a ride-seat yet) → device/multi-tab follow-up.
}
function endRide() {
  if (_rideSeat == null) return;
  coaster.occupy(_rideSeat, false);
  _rideSeat = null;
  // The ride drove the rig's FULL orientation (it banks/pitches WITH the cart). Level it on exit so
  // the player doesn't keep the tilt: in flat, reuse the shared reset (also clears camera roll/offset);
  // in VR/AR clear only the rig's roll/pitch (the headset still owns the camera). The train ends at the
  // station (a near-level spot), so the retained yaw is the travel heading.
  if (renderer.xr.isPresenting) rig.rotation.set(0, rig.rotation.y, 0);
  else resetFlatView();
  hud.toast('🎢 Back at the station — mind the step');
}
function updateRide() {
  const el = document.getElementById('ride-countdown');
  const cd = coaster.countdown();
  if (el) { if (cd > 0) { el.hidden = false; el.textContent = `🎢 Coaster departs in ${cd}s`; } else el.hidden = true; }
  if (_rideSeat && coaster.state() !== 'idle') {
    // Inherit the cart's EXACT parallel-transport frame (same source as the cart → no separate
    // lookAt, no flip): the rig gets the seat anchor's world position + orientation, so the rider
    // banks/pitches WITH the cart. The stable frame is the comfort fix; the vignette still applies.
    const anchor = coaster.seatAnchor(_rideSeat);
    if (anchor) { anchor.getWorldPosition(rig.position); anchor.getWorldQuaternion(rig.quaternion); }
  }
}

// ── 🦩 Feed the Nostriches (4.14) ────────────────────────────────────────────────
// Select an ostrich (unified pick) → an in-world "Feed · ⚡33" offer floats over it → confirm pays
// 33 credits (venue), a cracker arcs to its head, and its FIXED personality reaction plays. The feed
// is broadcast as {t:'feed', birdId, at:[x,y,z]} so everyone sees the same (deterministic) reaction.
// Reuses the credit rail, the unified select path, zap-burst FX, and the flock's FK.
const FEED_FEE = 33;
const FEED_BURST = { screamer: '💢', biter: '😵', kisser: '❤️', ostrich: '💨', sprinter: '💨', diva: null };
let _feedBird = null;                       // the bird currently being offered
const _feederHead = new THREE.Vector3();
// In-world offer: an opaque billboarded canvas chip, pickable (userData.feedAction), hidden until a
// bird is selected. Works in VR (required) and flat alike.
const feedOffer = (() => {
  const c = document.createElement('canvas'); c.width = 384; c.height = 150;
  const g = c.getContext('2d');
  g.fillStyle = 'rgba(11,13,19,0.94)'; roundRectPath(g, 6, 6, 372, 138, 26); g.fill();
  g.lineWidth = 4; g.strokeStyle = '#ff5aa8'; g.stroke();
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillStyle = '#ff5aa8'; g.font = '700 52px ui-monospace, Menlo, monospace'; g.fillText('🦩 Feed', 150, 76);
  g.fillStyle = '#f7931a'; g.font = '700 52px ui-monospace, Menlo, monospace'; g.fillText('⚡33', 300, 76);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(1.0, 0.39), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false }));
  m.renderOrder = 998; m.userData.feedAction = true; m.visible = false;
  scene.add(m);
  return m;
})();
function roundRectPath(g, x, y, w, h, r) {
  g.beginPath(); g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}
function canFeedHere() { return embodied() && zones.current()?.id === 'park'; }
// Selecting a bird → show the offer over it (only if eligible; ghosts / outside-park get nothing).
function offerFeed(birdId) {
  if (!canFeedHere()) { _feedBird = null; feedOffer.visible = false; if (!renderer.xr.isPresenting) hud.toast('🦩 Enter the park (with a ticket) to feed the nostriches'); return; }
  _feedBird = birdId; feedOffer.visible = true; positionFeedOffer();
}
function hideFeedOffer() { _feedBird = null; feedOffer.visible = false; }
// Confirm → pay + render locally + broadcast. Insufficient credits → the top-up path.
function confirmFeed() {
  const id = _feedBird; if (!id) return;
  if (!canFeedHere()) return hideFeedOffer();
  if (!requireSignedIn('feed the nostriches')) return;
  if (!flock.canFeed(id)) return hud.toast('🦩 Still munching — give it a moment');
  const res = wallet.spend(FEED_FEE, 'feed:nostrich');
  if (!res.ok) { hud.toast(`Need ${FEED_FEE} credits — top up in the menu`); return; }
  tickets.recordVenue(FEED_FEE);            // venue revenue + feed-count analytics seam
  hud.setBalance(wallet.getBalance());
  const at = camera.getWorldPosition(_feederHead).clone();
  doFeed(id, at);                           // local render
  voice.sendData({ t: 'feed', birdId: id, at: [at.x, at.y, at.z] }, { reliable: true }); // everyone sees it
  hideFeedOffer();                          // consume the offer
}
// The shared local render (used by confirmFeed AND the broadcast receiver — no payment on receive).
function doFeed(id, at) {
  const head = flock.headWorldPos(id, new THREE.Vector3());
  zapFx.snack(at, head);                    // crackers arc to the head
  const type = flock.feed(id, at);          // FK reaction (returns the type, or null if busy)
  if (!type) return;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  setTimeout(() => {                        // burst at the reaction's climax (when the snack lands)
    const h = flock.headWorldPos(id, new THREE.Vector3()); h.y += 0.35;
    if (type === 'screamer') zapFx.burstText(h, 'SQUAWK!');
    else { const e = FEED_BURST[type]; if (e) zapFx.burst(h, e, { scale: 0.55 }); } // diva = no burst (ignores you)
  }, reduced ? 200 : 850);
}
// Keep the offer floating just above the selected bird's head, billboarded to the camera.
const _boffP = new THREE.Vector3(), _boffC = new THREE.Vector3();
function updateFeedOffer() {
  if (!feedOffer.visible) return;
  if (!_feedBird || !canFeedHere()) return hideFeedOffer();
  flock.headWorldPos(_feedBird, _boffP);
  feedOffer.position.set(_boffP.x, _boffP.y + 0.6, _boffP.z);
  camera.getWorldPosition(_boffC);
  feedOffer.rotation.y = Math.atan2(_boffC.x - _boffP.x, _boffC.z - _boffP.z); // yaw-billboard
}
function positionFeedOffer() { updateFeedOffer(); }
// Broadcast receiver — render the feed for everyone (deterministic personality → all clients agree).
voice.onData((_id, msg) => {
  if (!msg || msg.t !== 'feed' || !msg.birdId) return;
  const at = Array.isArray(msg.at) ? new THREE.Vector3(msg.at[0], msg.at[1], msg.at[2]) : flock.headWorldPos(msg.birdId, new THREE.Vector3());
  doFeed(msg.birdId, at);
});

// Which-speaker picker. Single-speaker → direct; panel → a chooser (flat DOM here, the
// in-world menu Speakers page in VR). Also reused to pick a present participant to add as a
// co-speaker. `mode`: 'zap' | 'cospeaker'.
const _spPick = {
  root: document.getElementById('speaker-picker'), title: document.getElementById('sp-pick-title'),
  list: document.getElementById('sp-pick-list'), cancel: document.getElementById('sp-pick-cancel'),
};
_spPick.cancel.addEventListener('click', () => { _spPick.root.hidden = true; });
_spPick.root.addEventListener('click', (e) => { if (e.target === _spPick.root) _spPick.root.hidden = true; });
const spkLabel = (pk) => `@${pk.slice(0, 8)}`;
function openPickerFlat(title, rows, onPick) {   // rows: [{ pubkey, label }]
  _spPick.title.textContent = title;
  _spPick.list.innerHTML = '';
  for (const r of rows) {
    const b = document.createElement('button'); b.className = 'ctl';
    b.innerHTML = `<img src="${drawKeyface(r.pubkey, 44).toDataURL()}" alt=""><span>${r.label}</span>`;
    b.addEventListener('click', () => { _spPick.root.hidden = true; onPick(r.pubkey); });
    _spPick.list.appendChild(b);
  }
  _spPick.root.hidden = false;
}
const currentEventSpeakers = () => { const ev = booking.currentEvent(); return ev ? ev.speakers.slice(0, booking.MAX_SPEAKERS) : []; };
// The ONE "zap the speaker" entry (spend hub · in-world menu · welcome zap): direct for a
// single speaker, a picker for a panel.
function zapSpeakerFlow() {
  const spks = currentEventSpeakers();
  if (spks.length > 1) {
    if (renderer.xr.isPresenting) { xrMenu?.openSpeakers?.(); return; }   // VR → in-world Speakers page
    return openPickerFlat('🎙 Which speaker?', spks.map((pk) => ({ pubkey: pk, label: spkLabel(pk) })), (pk) => zapAvatar(pk, spkLabel(pk)));
  }
  const pk = spks[0];
  if (pk) return zapAvatar(pk, spkLabel(pk));
  const g = stageSpeakerGroup();
  if (g) return zapAvatar(g.userData.identity.pubkey, g.userData.identity.name);
  hud.toast('No one on stage to zap');
}

// Co-speaker (organizer): pick a PRESENT participant → add to the event.speakers[] locally +
// broadcast so every client converges, and the picked participant self-grants the pass.
function addCoSpeakerFlow() {
  const ev = booking.mine()[0] || booking.activeOrNextEvent();
  if (!ev) return hud.toast('No event of yours to add to');
  if (ev.speakers.length >= booking.MAX_SPEAKERS) return hud.toast(`Panels cap at ${booking.MAX_SPEAKERS} speakers`);
  const present = presence.avatars()
    .map((gr) => gr.userData.identity)
    .filter((id) => id && !ev.speakers.includes(id.pubkey));
  if (!present.length) return hud.toast('No present participants to add');
  openPickerFlat('➕ Add co-speaker', present.map((id) => ({ pubkey: id.pubkey, label: id.name || spkLabel(id.pubkey) })), (pk) => grantCoSpeaker(ev.id, pk));
}
function grantCoSpeaker(eventId, pubkey) {
  if (!booking.addSpeaker(eventId, pubkey)) return hud.toast(`Panels cap at ${booking.MAX_SPEAKERS} speakers`);
  voice.sendData({ t: 'cospeaker', eventId, pubkey }, { reliable: true });   // converge peers
  hud.toast(`Added ${spkLabel(pubkey)} as a co-speaker`);
}
// Inbound co-speaker signal: mirror the roster on every client; if it's ME, self-grant the
// event-scoped speaker pass (badge + backstage + stage access all flow from tickets).
voice.onData((_id, msg) => {
  if (!msg || msg.t !== 'cospeaker') return;
  booking.addSpeaker(msg.eventId, msg.pubkey);
  if (identity.current()?.pubkey === msg.pubkey) { tickets.grantSpeakerPass(msg.eventId); refreshEmbodiment(); hud.toast('🎙 You were added as a co-speaker'); }
});

// ── Frame loop ──────────────────────────────────────────────────────────────────
const clock = new THREE.Clock();
const _prevPos = new THREE.Vector3().copy(rig.position); // for the movement vignette

renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.1);
  updateScene(dt);            // scene mood: ring spread + star flicker (GPU clocks)
  updateLocomotion(dt, renderer);
  followBody();               // #5: pin the local body under the head in immersive modes
  updateSeat();               // panels: hold the seated drop / stand on walk-off (before broadcast)
  updateRide();               // coaster: pin the local rider to their seat (before broadcast)
  updateLocalHands();         // 4.8: show/hide local hand mitts (immersive + embodied)
  tickEmote(localBody, dt);   // 4.8: advance the local player's own emote (peers tick via the pool)
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
  // Zone-entry access GATE: if we've wandered into a zone our ticket doesn't allow, softly
  // clamp us back to just outside its boundary (no hard teleport) and prompt the purchase.
  // Runs BEFORE zones.update, so the HUD pill only fires when we're LEGITIMATELY inside.
  // Smoking additionally needs the mic-ON confirm (smokingMicOk); until then a ticketed
  // player is soft-bounced at its edge exactly like a no-access door.
  const gate = accessClamp(rig.position.x, rig.position.z, (zn) => !!tickets.flags()[zn.requires] && (zn.id !== 'smoking' || micOk.has('smoking')));
  if (gate.blocked) { rig.position.x = gate.x; rig.position.z = gate.z; onZoneBlocked(gate.blocked); }
  else _lastBlocked = null;

  _prevPos.copy(rig.position);
  zones.update(rig.position.x, rig.position.z); // social-zone enter/leave seam (self-gates on movement)

  zoneAudio.update(dt);                     // proximity gain + zone render-gating (self-throttled ~5Hz)
  zones.setLiveOccupancy(presence.zoneCounts()); // real occupancy (re-textures plaques only on change)
  updateCigarettes(dt);                     // lit cigarette on every Smoking occupant
  updateChairs();                           // panels: spawn/arrange stage chairs for 2+ speakers
  flock.update(dt);                         // 🦩 park flock FK animation
  coaster.update(dt);                       // 🎢 train motion + ride state machine

  zapFx.update(dt);           // in-world zap bursts (no-op when none are active)
  commentBoard.update(dt);    // live-feed scroll + sticky top-wall refresh
  queuePanel.update(dt);      // pulse the pedestal "you're up" ring (only when set)
  updateVRBoardScroll(dt);    // VR: aim right controller at LIVE + right-stick Y scrolls
  updateMenu();               // in-world menu: billboard + laser hover (only while open)
  updateFeedOffer();          // 🦩 4.14: float the Feed offer over the selected bird (billboard)
  updateXrButtonDebug();      // TEMP 4.13 #1 · X-DBG — controller button readout (strip after)

  renderer.render(scene, camera);
});
