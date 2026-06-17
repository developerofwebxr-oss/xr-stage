import * as THREE from 'three';
import { config } from './config.js';
import { buildScene } from './room/scene.js';
import { STAGE_POS, STAGE_TOP_Y, QUESTIONER_POS, constrainPosition, boundaryFor } from './room/zones.js';
import { seedPlaceholders, createPlayerBody, MIN_BODY_GAP } from './room/avatars.js';
import { createLocomotion } from './xr/locomotion.js';
import { setupXR } from './xr/session.js';
import { createHud } from './ui/hud.js';
import { createJoystick } from './ui/joystick.js';
import { Voice } from './voice/livekit.js';
import { createPresence } from './state/presence.js';
import { stageState, setState, onStateChange } from './state/stageState.js';

// main.js — boots the four-mode WebXR spatial stage and runs the frame loop.
// Wiring only: each concern lives in its own module; here we connect their seams.

// ── Renderer ────────────────────────────────────────────────────────────────────
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.xr.enabled = true;
document.getElementById('app').appendChild(renderer.domElement);

// ── Scene + people ──────────────────────────────────────────────────────────────
const { scene, setARMode } = buildScene();
// Static ambiance capsules; their positions feed avatar separation so the player
// can't stand inside them either.
const staticBodies = seedPlaceholders(scene);

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

const { rig, update: updateLocomotion, setFreeLook, setMoveInput } =
  createLocomotion(camera, renderer.domElement, {
    spawn,
    isMobile,
    constrain: (x, z) => constrainPosition(who, x, z),
    onBoundary: () => { boundaryGlow = 1; }, // soft edge stop + glow, no snap-back
    // Pointer lock dropped on its own (e.g. Esc) → reflect it in the toggle.
    onFreeLookEnd: () => { freeLookOn = false; hud.setFreeLook(false); },
  });
scene.add(rig);

// Local player body (capsule), parented to the rig so it moves + turns with us.
rig.add(createPlayerBody(who.role === 'speaker' ? 0xf7931a : 0x4cc2ff));

// ── HUD ─────────────────────────────────────────────────────────────────────────
const hud = createHud();
hud.setRoom(config.room);
stageState.role = config.role;

// Desktop hint (fine pointer only): default look is hold-drag.
if (!isMobile) hud.showLockHint(true);

// Mobile-only: the on-screen joystick (movement). Look is drag / gyro via Free look.
if (isMobile) {
  document.body.classList.add('mobile'); // lifts the joystick clear of the control bar
  createJoystick(document.getElementById('joystick'), {
    onMove: (strafe, forward) => setMoveInput(strafe, forward),
  });
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
});

// ── WebXR sessions + mode cluster (B2) ──────────────────────────────────────────
// Screen is active by default; VR/AR enable + wire once feature-detection resolves.
hud.setActiveMode('screen');
setupXR(renderer, {
  onModeChange: (mode) => {
    hud.setActiveMode(mode === 'flat' ? 'screen' : mode);
    hud.showOverlay(mode === 'flat');            // no 2D HUD inside immersive
    document.getElementById('joystick').hidden = mode !== 'flat' ? true : !isMobile;
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
}), staticBodies);

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

// ── Resize ────────────────────────────────────────────────────────────────────
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ── Frame loop ──────────────────────────────────────────────────────────────────
const clock = new THREE.Clock();

renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.1);
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
