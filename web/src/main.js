import * as THREE from 'three';
import { config } from './config.js';
import { buildScene, STAGE_POS } from './room/scene.js';
import { seedPlaceholders } from './room/avatars.js';
import { createLocomotion } from './xr/locomotion.js';
import { setupXR } from './xr/session.js';
import { createHud } from './ui/hud.js';
import { Voice } from './voice/livekit.js';
import { createPresence } from './state/presence.js';
import { stageState, setState, onStateChange } from './state/stageState.js';

// main.js — boots the four-mode WebXR spatial stage and runs the frame loop.
//
// This is the wiring layer only: each concern (scene, locomotion, xr session,
// voice, presence, hud) lives in its own module. The job here is to create them,
// connect their seams, and drive update() every frame.

// ── Renderer ────────────────────────────────────────────────────────────────────
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); // cap DPR for mobile/Quest fps
renderer.setSize(innerWidth, innerHeight);
renderer.xr.enabled = true;
document.getElementById('app').appendChild(renderer.domElement);

// ── Scene + camera + people ───────────────────────────────────────────────────
const { scene, setARMode } = buildScene();
seedPlaceholders(scene, STAGE_POS);

const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.05, 200);
const { rig, update: updateLocomotion, enableDeviceOrientation } = createLocomotion(camera, renderer.domElement);
scene.add(rig);

// ── HUD ─────────────────────────────────────────────────────────────────────────
const hud = createHud();
hud.setMode('flat');
stageState.role = config.role;
hud.setRole(config.role);

// Desktop pointer-lock hint: show it only on fine-pointer (mouse) devices.
if (matchMedia('(pointer: fine)').matches) {
  hud.showLockHint(true);
  document.addEventListener('pointerlockchange', () => {
    hud.showLockHint(document.pointerLockElement !== renderer.domElement);
  });
}

// Mobile gyro opt-in: reuse the Recenter button to request device orientation.
if (matchMedia('(pointer: coarse)').matches) {
  hud.showRecenter(true);
  hud.el.btnRecenter.textContent = 'Use gyro';
  hud.onRecenter(async () => {
    const ok = await enableDeviceOrientation();
    hud.el.btnRecenter.textContent = ok ? 'Gyro on' : 'Gyro denied';
    hud.el.btnRecenter.disabled = true;
  });
}

// ── WebXR sessions ────────────────────────────────────────────────────────────
setupXR(renderer, { btnVr: hud.el.btnVr, btnAr: hud.el.btnAr }, {
  onModeChange: (mode) => hud.setMode(mode),
  onARMode: (on) => setARMode(on),
});

// ── Voice + presence (lazy — only after the user clicks "Join voice") ────────────
const voice = new Voice({
  onCounts: ({ participantCount, speakerCount }) => {
    setState({ participantCount, speakerCount });
  },
});
let presence = null;
let muted = false;

// Reflect shared state into the HUD whenever it changes.
onStateChange((s) => {
  hud.setParticipantCount(s.participantCount);
  hud.setSpeakerCount(s.speakerCount);
});

hud.onVoice(async () => {
  try {
    await voice.connect();
    hud.setVoiceJoined();
    // Presence rides the same connection: broadcast our rig position, render peers.
    presence = createPresence(voice, scene, () => rig.position);
  } catch (err) {
    console.error('[voice] join failed:', err);
    hud.el.btnVoice.textContent = 'Voice failed — retry';
  }
});

hud.onMute(async () => {
  muted = !muted;
  await voice.setMuted(muted);
  hud.setMuted(muted);
});

// ── Resize ────────────────────────────────────────────────────────────────────
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ── Frame loop ──────────────────────────────────────────────────────────────────
// setAnimationLoop (not requestAnimationFrame) so the SAME loop drives flat AND
// immersive frames — Three.js swaps to the XR frame source automatically.
const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.1); // clamp huge dt after a tab stall
  updateLocomotion(dt, renderer);
  if (presence) presence.update(dt);
  renderer.render(scene, camera);
});
