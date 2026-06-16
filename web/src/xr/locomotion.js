import * as THREE from 'three';

// xr/locomotion.js — one module, four input styles, sharing a single "player rig".
//
// The rig is a Group that holds the camera. Moving/rotating the rig moves the
// viewer through the world; in immersive sessions Three.js adds the live head pose
// ON TOP of the rig transform, so the same rig offset works for VR locomotion and
// AR (where the rig stays put and you physically walk).
//
//   desktop → pointer-lock mouse-look (yaw on rig, pitch on camera) + WASD
//   mobile  → one-finger drag-look, optional device-orientation tilt
//   VR      → right thumbstick smooth-locomotion (move) + left thumbstick snap-turn
//   AR      → nothing; the rig is fixed and the user walks (head pose moves them)
//
// createLocomotion() wires desktop+mobile immediately and returns
// { rig, update, enableDeviceOrientation, disableDeviceOrientation, setMoveInput }.
// update(dt, renderer) is called every frame and reads VR thumbsticks when immersive.
//
// `spawn` ({ position:[x,y,z], yaw }) sets where the viewer starts and which way
// they face — applied to the RIG so it holds in flat, VR, and AR alike. main.js
// derives it from role (audience facing the stage vs speaker on the stage).

const MOVE_SPEED = 3.0;   // metres/sec for WASD + VR stick + joystick (analog cap)
const SNAP_TURN = Math.PI / 6; // 30° per left-stick flick
const LOOK_SENSITIVITY = 0.0022;
const PITCH_LIMIT = Math.PI / 2 - 0.05;

export function createLocomotion(camera, domElement, { spawn } = {}) {
  const start = spawn || { position: [0, 0, 4], yaw: 0 };

  // Rig holds the camera. Camera keeps only pitch; the rig owns yaw + position,
  // so "forward" for WASD is always the rig's facing regardless of head pitch.
  const rig = new THREE.Group();
  rig.position.set(start.position[0], start.position[1], start.position[2]);
  rig.add(camera);
  // Eye height lives on the CAMERA, not the rig: in flat mode this is the viewer's
  // height; in immersive mode Three overwrites the camera pose from the floor-
  // relative head pose, so the rig staying at y=0 keeps VR/AR height correct.
  camera.position.set(0, 1.6, 0);

  // Spawn yaw. yaw=0 faces -Z; the scene's stage sits at -Z, so the default
  // (audience) spawn looks straight at it. The speaker spawn uses yaw=π (face +Z,
  // toward the audience). Applied to the rig immediately so the very first rendered
  // frame is already oriented correctly.
  let yaw = start.yaw || 0;
  let pitch = 0;
  rig.rotation.y = yaw;
  const keys = new Set();

  // Analog move input from the mobile joystick, normalised to [-1, 1]:
  //   x = strafe (right positive), z = forward (positive = toward facing).
  // Fed in via setMoveInput(); merged with WASD in update() so there's one path.
  const moveInput = { x: 0, z: 0 };

  // ── Desktop: pointer lock + mouse-look + WASD ─────────────────────────────────
  const wantsPointerLock = matchMedia('(pointer: fine)').matches;

  domElement.addEventListener('click', () => {
    // Only grab the pointer on real mouse devices and only outside immersive XR.
    if (wantsPointerLock && !document.pointerLockElement) domElement.requestPointerLock();
  });

  document.addEventListener('mousemove', (e) => {
    if (document.pointerLockElement !== domElement) return;
    yaw -= e.movementX * LOOK_SENSITIVITY;
    pitch -= e.movementY * LOOK_SENSITIVITY;
    pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, pitch));
  });

  addEventListener('keydown', (e) => keys.add(e.code));
  addEventListener('keyup', (e) => keys.delete(e.code));

  // ── Mobile: one-finger drag-look ──────────────────────────────────────────────
  let dragId = null, lastX = 0, lastY = 0;
  domElement.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return; // mouse handled by pointer lock
    dragId = e.pointerId; lastX = e.clientX; lastY = e.clientY;
  });
  domElement.addEventListener('pointermove', (e) => {
    if (e.pointerId !== dragId) return;
    yaw -= (e.clientX - lastX) * LOOK_SENSITIVITY * 1.6;
    pitch -= (e.clientY - lastY) * LOOK_SENSITIVITY * 1.6;
    pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, pitch));
    lastX = e.clientX; lastY = e.clientY;
  });
  const endDrag = (e) => { if (e.pointerId === dragId) dragId = null; };
  domElement.addEventListener('pointerup', endDrag);
  domElement.addEventListener('pointercancel', endDrag);

  // ── Mobile: optional device-orientation tilt ──────────────────────────────────
  // Off by default (needs a permission prompt on iOS); enableDeviceOrientation()
  // is exposed so a UI gesture can opt in. When on, gyro drives yaw/pitch directly.
  let gyro = null; // { alpha, beta, gamma } in radians, or null
  function onDeviceOrientation(e) {
    if (e.alpha == null) return;
    gyro = {
      yaw: THREE.MathUtils.degToRad(e.alpha),
      pitch: THREE.MathUtils.degToRad(e.beta - 90),
    };
  }
  async function enableDeviceOrientation() {
    // iOS 13+ gates the sensor behind an explicit permission request (must be
    // called from a user gesture — the Gyro button's click handler).
    const needsPermission = typeof DeviceOrientationEvent !== 'undefined'
      && typeof DeviceOrientationEvent.requestPermission === 'function';
    if (needsPermission) {
      const res = await DeviceOrientationEvent.requestPermission().catch(() => 'denied');
      if (res !== 'granted') return false;
    }
    addEventListener('deviceorientation', onDeviceOrientation);
    return true;
  }
  // Turn gyro look back off: stop listening and drop to drag-look. yaw/pitch keep
  // their last gyro values, so the view doesn't jump when control hands back.
  function disableDeviceOrientation() {
    removeEventListener('deviceorientation', onDeviceOrientation);
    gyro = null;
  }

  // Set the analog move vector from the mobile joystick (forward positive).
  function setMoveInput(x, z) { moveInput.x = x; moveInput.z = z; }

  // Reusable scratch vectors (avoid per-frame allocation).
  const _forward = new THREE.Vector3();
  const _right = new THREE.Vector3();
  let snapCooldown = false;

  // ── update ────────────────────────────────────────────────────────────────────
  function update(dt, renderer) {
    const immersive = renderer.xr.isPresenting;

    if (immersive) {
      readVRSticks(dt, renderer);
    } else {
      // Flat / mobile: apply look orientation to rig (yaw) + camera (pitch).
      if (gyro) { yaw = gyro.yaw; pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, gyro.pitch)); }
      rig.rotation.y = yaw;
      camera.rotation.x = pitch;

      // ── One movement path for WASD + joystick ───────────────────────────────
      // Build an intent vector (ix = strafe, iz = forward) from keys AND the
      // analog joystick, then clamp its length to 1 so diagonals/full-stick never
      // exceed MOVE_SPEED. Joystick magnitude < 1 gives proportional (analog) speed.
      let ix = moveInput.x;
      let iz = moveInput.z;
      if (keys.has('KeyW') || keys.has('ArrowUp'))    iz += 1;
      if (keys.has('KeyS') || keys.has('ArrowDown'))  iz -= 1;
      if (keys.has('KeyD') || keys.has('ArrowRight')) ix += 1;
      if (keys.has('KeyA') || keys.has('ArrowLeft'))  ix -= 1;

      const mag = Math.hypot(ix, iz);
      if (mag > 1) { ix /= mag; iz /= mag; }

      if (ix !== 0 || iz !== 0) {
        _forward.set(0, 0, -1).applyAxisAngle(UP, yaw); // rig forward on the ground
        _right.set(1, 0, 0).applyAxisAngle(UP, yaw);
        const step = MOVE_SPEED * dt;
        rig.position.addScaledVector(_forward, iz * step);
        rig.position.addScaledVector(_right, ix * step);
      }
    }
  }

  // Read Quest thumbsticks: right stick = move (relative to head yaw), left stick
  // X = snap-turn. AR sessions usually have no controllers, so this just no-ops.
  function readVRSticks(dt, renderer) {
    const session = renderer.xr.getSession();
    if (!session) return;
    const headYaw = headYawOf(renderer);

    for (const src of session.inputSources) {
      const gp = src.gamepad;
      if (!gp || gp.axes.length < 4) continue;
      // xr-standard layout: axes[2]=stick X, axes[3]=stick Y.
      const x = gp.axes[2] ?? 0;
      const y = gp.axes[3] ?? 0;

      if (src.handedness === 'right') {
        if (Math.abs(x) > 0.15 || Math.abs(y) > 0.15) {
          _forward.set(0, 0, 1).applyAxisAngle(UP, headYaw);   // stick up (y<0) = forward
          _right.set(1, 0, 0).applyAxisAngle(UP, headYaw);
          const step = MOVE_SPEED * dt;
          rig.position.addScaledVector(_forward, y * step);
          rig.position.addScaledVector(_right, x * step);
        }
      } else if (src.handedness === 'left') {
        // Snap-turn on a decisive left/right flick, with a release cooldown.
        if (Math.abs(x) > 0.7 && !snapCooldown) {
          rig.rotation.y -= Math.sign(x) * SNAP_TURN;
          snapCooldown = true;
        } else if (Math.abs(x) < 0.3) {
          snapCooldown = false;
        }
      }
    }
  }

  return { rig, update, enableDeviceOrientation, disableDeviceOrientation, setMoveInput };
}

const UP = new THREE.Vector3(0, 1, 0);

// Current head yaw (Y rotation) of the XR camera, for head-relative VR movement.
const _q = new THREE.Quaternion();
const _e = new THREE.Euler(0, 0, 0, 'YXZ');
function headYawOf(renderer) {
  renderer.xr.getCamera().getWorldQuaternion(_q);
  _e.setFromQuaternion(_q, 'YXZ');
  return _e.y;
}
