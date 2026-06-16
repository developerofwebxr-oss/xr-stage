import * as THREE from 'three';
import { config } from './config.js';
import { buildScene, STAGE_POS } from './room/scene.js';
import { seedPlaceholders, createPlayerBody } from './room/avatars.js';
import { createLocomotion } from './xr/locomotion.js';
import { setupXR } from './xr/session.js';
import { createHud } from './ui/hud.js';
import { createJoystick } from './ui/joystick.js';
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
seedPlaceholders(scene); // static ambiance only — no prop where a real person stands

const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.05, 200);

// ── Role-based spawn ──────────────────────────────────────────────────────────
// Listener: stand in the audience a few metres in front of the stage, facing it
// (yaw 0 → looking -Z, where the stage/backdrop are) so it's centred on load.
// Speaker: stand on the platform near its front edge, facing the audience (yaw π
// → looking +Z). y stays 0 so VR/AR floor-relative head height is correct.
const spawn = config.role === 'speaker'
  ? { position: [STAGE_POS.x, 0, STAGE_POS.z + 2], yaw: Math.PI }
  : { position: [STAGE_POS.x, 0, STAGE_POS.z + 11], yaw: 0 };

const { rig, update: updateLocomotion, enableDeviceOrientation, disableDeviceOrientation, setMoveInput } =
  createLocomotion(camera, renderer.domElement, { spawn });
scene.add(rig);

// ── Local player body ───────────────────────────────────────────────────────────
// A capsule in the room avatar style, parented to the rig so it follows the
// player's position + yaw. This replaces the old static on-stage prop: as a
// speaker, the figure standing on the stage IS you. Speaker = bitcoin orange so
// the stage figure stands out; listener = a cool blue. Others see us via their own
// presence-driven AvatarPool (full capsule + head), not this local mesh.
rig.add(createPlayerBody(config.role === 'speaker' ? 0xf7931a : 0x4cc2ff));

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

// ── Mobile-only controls: gyro look toggle + movement joystick ──────────────────
// Feature-detect a touch device with no fine pointer — this excludes desktops and
// touchscreen laptops, rather than guessing from a narrow viewport width.
const isMobile = matchMedia('(pointer: coarse)').matches && !matchMedia('(pointer: fine)').matches;
if (isMobile) {
  hud.showLockHint(false);

  // Gyro toggle: default off (drag-to-look). Enabling requests device-orientation
  // permission (iOS prompts on this user gesture); tapping again returns to drag.
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

  // Virtual joystick → feeds the SAME locomotion path as desktop WASD.
  createJoystick(document.getElementById('joystick'), {
    onMove: (strafe, forward) => setMoveInput(strafe, forward),
  });
}

// ── WebXR sessions ────────────────────────────────────────────────────────────
setupXR(renderer, { btnVr: hud.el.btnVr, btnAr: hud.el.btnAr }, {
  onModeChange: (mode) => {
    hud.setMode(mode);
    // The joystick sits outside #hud, so hide it explicitly during immersive
    // sessions; restore it (mobile only) back in flat mode.
    const js = document.getElementById('joystick');
    js.hidden = mode !== 'flat' ? true : !isMobile;
  },
  onARMode: (on) => setARMode(on),
});

// ── Voice + presence (lazy — only after the user clicks "Join voice") ────────────
const voice = new Voice({
  onCounts: ({ participantCount, speakerCount }) => {
    setState({ participantCount, speakerCount });
  },
  // Reflect idle → connecting → connected → failed in the HUD badge.
  onState: (state) => hud.setVoiceState(state),
});
let presence = null;

// Reflect shared state into the HUD whenever it changes.
onStateChange((s) => {
  hud.setParticipantCount(s.participantCount);
  hud.setSpeakerCount(s.speakerCount);
});

// ── Role-aware voice toggle (Listen / Speak) + request-to-speak placeholder ──────
// Listener: "Listen" on/off controls hearing the room. Speaker: "Speak" on/off
// controls mic publish (the speaker always hears the room). Either way the FIRST
// "on" tap both joins the room and satisfies the browser's autoplay gesture.
const isSpeaker = config.role === 'speaker';
const verb = isSpeaker ? 'Speak' : 'Listen';
let active = false; // listener: hearing; speaker: mic publishing

hud.setVoiceToggle(`${verb}: off`);
hud.showRequest(!isSpeaker); // disabled placeholder, listeners only (Fix 2)
hud.onRequest(() => hud.toast('Request to speak — available in a later phase'));

hud.onVoice(async () => {
  const next = !active;
  hud.el.btnVoice.disabled = true; // guard against double-taps mid-connect
  try {
    if (!voice.isConnected) {
      await voice.connect();        // drives onState connecting → connected
      await voice.setListening(true); // resume audio playback within the gesture
      // Presence rides the same connection: broadcast our pose, render peers.
      presence = createPresence(voice, scene, () => ({
        x: rig.position.x, y: rig.position.y, z: rig.position.z, yaw: rig.rotation.y,
      }));
    }
    if (isSpeaker) await voice.setMicEnabled(next);
    else await voice.setListening(next);
    active = next;
    hud.setVoiceToggle(`${verb}: ${active ? 'on' : 'off'}`);
  } catch (err) {
    // voice.connect already set state 'failed' + logged the cause; show the reason
    // and leave the toggle off so the next tap retries.
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
// setAnimationLoop (not requestAnimationFrame) so the SAME loop drives flat AND
// immersive frames — Three.js swaps to the XR frame source automatically.
const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.1); // clamp huge dt after a tab stall
  updateLocomotion(dt, renderer);
  if (presence) presence.update(dt);
  renderer.render(scene, camera);
});
