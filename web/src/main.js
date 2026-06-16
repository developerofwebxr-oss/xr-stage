import * as THREE from 'three';
import { config } from './config.js';
import { buildScene } from './room/scene.js';
import { STAGE_POS, STAGE_TOP_Y, constrainPosition, boundaryFor } from './room/zones.js';
import { seedPlaceholders, createPlayerBody } from './room/avatars.js';
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
seedPlaceholders(scene); // static ambiance only — no prop where a real person stands

const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.05, 200);

// Who am I, spatially? Drives spawn + the movement clamp (A2/A3).
const who = { role: config.role, isNextUp: config.isNextUp };

// ── Role-based spawn ──────────────────────────────────────────────────────────
// Speaker: on the stage TOP near the front, facing the audience (+Z).
// Next-up: inside the under-stage green room, facing the front opening (+Z).
// Audience: in front of the stage, facing it (-Z).
let spawn;
if (who.role === 'speaker')   spawn = { position: [STAGE_POS.x, STAGE_TOP_Y, STAGE_POS.z + 1.5], yaw: Math.PI };
else if (who.isNextUp)        spawn = { position: [STAGE_POS.x, 0, STAGE_POS.z], yaw: Math.PI };
else                          spawn = { position: [STAGE_POS.x, 0, STAGE_POS.z + 12], yaw: 0 };

// ── Boundary glow (A2): a ring that flares when the player hits their zone edge ──
const bnd = boundaryFor(who);
const ringMat = new THREE.MeshBasicMaterial({
  color: 0xf7931a, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false,
});
const boundaryRing = new THREE.Mesh(new THREE.TorusGeometry(bnd.radius, 0.06, 12, 96), ringMat);
boundaryRing.rotation.x = -Math.PI / 2;
boundaryRing.position.set(STAGE_POS.x, bnd.y, STAGE_POS.z);
scene.add(boundaryRing);
let boundaryGlow = 0;

const { rig, update: updateLocomotion, enableDeviceOrientation, disableDeviceOrientation, setMoveInput } =
  createLocomotion(camera, renderer.domElement, {
    spawn,
    constrain: (x, z) => constrainPosition(who, x, z),
    onBoundary: () => { boundaryGlow = 1; }, // soft edge stop + glow, no snap-back
  });
scene.add(rig);

// Local player body (capsule), parented to the rig so it moves + turns with us.
rig.add(createPlayerBody(who.role === 'speaker' ? 0xf7931a : 0x4cc2ff));

// ── HUD ─────────────────────────────────────────────────────────────────────────
const hud = createHud();
hud.setRoom(config.room);
stageState.role = config.role;

// Desktop pointer-lock hint (fine pointer only).
if (matchMedia('(pointer: fine)').matches) {
  hud.showLockHint(true);
  document.addEventListener('pointerlockchange', () => {
    hud.showLockHint(document.pointerLockElement !== renderer.domElement);
  });
}

// ── Mobile-only controls: gyro toggle + joystick ────────────────────────────────
const isMobile = matchMedia('(pointer: coarse)').matches && !matchMedia('(pointer: fine)').matches;
if (isMobile) {
  document.body.classList.add('mobile'); // lifts the joystick clear of the control bar
  hud.showLockHint(false);

  let gyroOn = false;
  hud.showGyro(true);
  hud.setGyro(false);
  hud.onGyro(async () => {
    if (!gyroOn) {
      gyroOn = await enableDeviceOrientation();
      hud.setGyro(gyroOn);
      if (!gyroOn) hud.el.btnGyro.textContent = 'Gyro: denied';
    } else {
      disableDeviceOrientation();
      gyroOn = false;
      hud.setGyro(false);
    }
  });

  createJoystick(document.getElementById('joystick'), {
    onMove: (strafe, forward) => setMoveInput(strafe, forward),
  });
}

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

// ── Voice + presence (lazy — only after the user toggles Listen/Speak) ───────────
const voice = new Voice({
  onCounts: ({ participantCount, speakerCount }) => setState({ participantCount, speakerCount }),
  onState: (state) => hud.setVoiceState(state),
});
let presence = null;

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
      presence = createPresence(voice, scene, () => ({
        x: rig.position.x, y: rig.position.y, z: rig.position.z, yaw: rig.rotation.y,
      }));
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
  if (presence) presence.update(dt);
  // Fade the boundary glow (held at full while the player pushes the edge).
  if (boundaryGlow > 0) { boundaryGlow = Math.max(0, boundaryGlow - dt * 1.6); ringMat.opacity = boundaryGlow * 0.6; }
  renderer.render(scene, camera);
});
