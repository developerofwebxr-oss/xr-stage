import * as THREE from 'three';

// xr/locomotion.js — one module, four input styles, sharing a single "player rig".
//
// The rig is a Group that holds the camera. Moving/rotating the rig moves the
// viewer through the world; in immersive sessions Three.js adds the live head pose
// ON TOP of the rig transform, so the same rig offset works for VR locomotion and
// AR (where the rig stays put and you physically walk).
//
// LOOK (one path → rig yaw + camera pitch), selected by the "Free look" toggle:
//   Free look OFF (default): desktop = hold-left-drag, mobile = touch-drag.
//   Free look ON:            desktop = pointer-lock free mouse, mobile = gyro.
// MOVE: WASD (desktop) + analog joystick (mobile) + VR thumbstick — merged.
//
// createLocomotion() returns { rig, update, setFreeLook, setMoveInput }.
// update(dt, renderer) runs every frame (reads VR thumbsticks when immersive).

const MOVE_SPEED = 3.0;          // metres/sec for WASD + VR stick + joystick
const SNAP_TURN = Math.PI / 6;   // 30° per left-stick flick
const LOOK_SENSITIVITY = 0.0022; // pointer-lock radians per mouse pixel
const DRAG_SENSITIVITY = 0.0035; // hold/touch-drag radians per pixel
const PITCH_LIMIT = Math.PI / 2 - 0.05;
const GYRO_LERP = 0.12;                          // low-pass toward the gyro target
const GYRO_DEADZONE = THREE.MathUtils.degToRad(0.6); // ignore sub-degree sensor jitter

// `constrain(x, z) -> { x, z, y, hit }` keeps the rig inside its zone every frame;
// `onBoundary()` fires the frame a limit is hit. `isMobile` picks the Free-look
// mechanism (gyro vs pointer-lock). `onFreeLookEnd()` fires if pointer lock exits
// on its own (e.g. Esc) so the UI can untoggle.
export function createLocomotion(camera, domElement, {
  spawn, constrain, onBoundary, isMobile = false, onFreeLookEnd,
} = {}) {
  const start = spawn || { position: [0, 0, 4], yaw: 0 };

  // Rig holds the camera. Camera keeps only pitch; the rig owns yaw + position.
  const rig = new THREE.Group();
  rig.position.set(start.position[0], start.position[1], start.position[2]);
  rig.add(camera);
  // Eye height lives on the CAMERA in flat mode; in immersive mode Three overwrites
  // the camera pose from the floor-relative head pose, so the rig stays at y=0.
  camera.position.set(0, 1.6, 0);

  let yaw = start.yaw || 0;
  let pitch = 0;
  rig.rotation.y = yaw;
  const keys = new Set();
  const moveInput = { x: 0, z: 0 }; // analog joystick, [-1,1]; merged with WASD

  // Free look: false → drag look; true → pointer-lock (desktop) / gyro (mobile).
  let freeLook = false;
  const lookMode = () => (!freeLook ? 'drag' : (isMobile ? 'gyro' : 'pointerlock'));

  // ── Drag look (default): hold-left-drag (desktop) or touch-drag (mobile) ────────
  // One pointer path for mouse + touch; active only when NOT in free look.
  let dragId = null, lastX = 0, lastY = 0;
  domElement.addEventListener('pointerdown', (e) => {
    if (lookMode() !== 'drag') return;
    dragId = e.pointerId; lastX = e.clientX; lastY = e.clientY;
  });
  domElement.addEventListener('pointermove', (e) => {
    if (e.pointerId !== dragId) return;
    yaw -= (e.clientX - lastX) * DRAG_SENSITIVITY;
    pitch = clampPitch(pitch - (e.clientY - lastY) * DRAG_SENSITIVITY);
    lastX = e.clientX; lastY = e.clientY;
  });
  const endDrag = (e) => { if (e.pointerId === dragId) dragId = null; };
  domElement.addEventListener('pointerup', endDrag);
  domElement.addEventListener('pointercancel', endDrag);

  // ── Pointer-lock free look (desktop, Free look ON) ──────────────────────────────
  document.addEventListener('mousemove', (e) => {
    if (document.pointerLockElement !== domElement) return;
    yaw -= e.movementX * LOOK_SENSITIVITY;
    pitch = clampPitch(pitch - e.movementY * LOOK_SENSITIVITY);
  });
  document.addEventListener('pointerlockchange', () => {
    // Lock dropped (e.g. Esc) while in desktop free look → leave free look.
    if (freeLook && !isMobile && document.pointerLockElement !== domElement) {
      freeLook = false;
      if (onFreeLookEnd) onFreeLookEnd();
    }
  });

  addEventListener('keydown', (e) => keys.add(e.code));
  addEventListener('keyup', (e) => keys.delete(e.code));

  // ── Gyro free look (mobile, Free look ON) ───────────────────────────────────────
  // Smoothed: deviceorientation feeds a TARGET yaw/pitch (deadzoned + calibrated to
  // the heading at enable); update() lerps the live yaw/pitch toward it each frame.
  const gyroTarget = { yaw: 0, pitch: 0 };
  let gyroActive = false, gyroCalibrated = false, gyroYawOffset = 0;

  function onDeviceOrientation(e) {
    if (e.alpha == null) return;
    // Full device quaternion (incl. screen orientation), then extract yaw/pitch.
    deviceQuaternion(
      _gq,
      THREE.MathUtils.degToRad(e.alpha),
      THREE.MathUtils.degToRad(e.beta),
      THREE.MathUtils.degToRad(e.gamma),
      THREE.MathUtils.degToRad(screenAngle()),
    );
    _ge.setFromQuaternion(_gq, 'YXZ');
    let ty = _ge.y;
    const tp = clampPitch(_ge.x);
    // Calibrate "forward" to the current rig yaw on first sample after enabling, so
    // it doesn't snap to a weird compass heading.
    if (!gyroCalibrated) { gyroYawOffset = yaw - ty; gyroCalibrated = true; }
    ty += gyroYawOffset;
    // Deadzone: hold the target steady against micro-jitter when nearly still.
    if (Math.abs(shortAngle(ty - gyroTarget.yaw)) < GYRO_DEADZONE
        && Math.abs(tp - gyroTarget.pitch) < GYRO_DEADZONE) return;
    gyroTarget.yaw = ty;
    gyroTarget.pitch = tp;
  }

  async function enableGyro() {
    // iOS 13+ gates the sensor behind a permission request (must come from the
    // user gesture that toggled Free look on).
    const needsPermission = typeof DeviceOrientationEvent !== 'undefined'
      && typeof DeviceOrientationEvent.requestPermission === 'function';
    if (needsPermission) {
      const res = await DeviceOrientationEvent.requestPermission().catch(() => 'denied');
      if (res !== 'granted') return false;
    }
    gyroCalibrated = false;                 // recalibrate forward on (re)enable
    gyroTarget.yaw = yaw; gyroTarget.pitch = pitch;
    addEventListener('deviceorientation', onDeviceOrientation);
    gyroActive = true;
    return true;
  }
  function disableGyro() {
    removeEventListener('deviceorientation', onDeviceOrientation);
    gyroActive = false;
  }

  // ── setFreeLook(on) — toggled by the HUD. Async (mobile needs the permission). ──
  async function setFreeLook(on) {
    if (on) {
      freeLook = true;
      if (isMobile) {
        const ok = await enableGyro();
        if (!ok) { freeLook = false; return false; } // permission denied
        return true;
      }
      domElement.requestPointerLock?.(); // desktop: gesture-driven lock
      return true;
    }
    freeLook = false;
    if (isMobile) disableGyro();
    else if (document.pointerLockElement === domElement) document.exitPointerLock();
    return true;
  }

  function setMoveInput(x, z) { moveInput.x = x; moveInput.z = z; }

  // Reusable scratch vectors.
  const _forward = new THREE.Vector3();
  const _right = new THREE.Vector3();
  let snapCooldown = false;

  // ── update ────────────────────────────────────────────────────────────────────
  function update(dt, renderer) {
    const immersive = renderer.xr.isPresenting;

    if (immersive) {
      readVRSticks(dt, renderer);
    } else {
      // Gyro look low-passes toward its target; drag/pointer-lock already wrote
      // yaw/pitch directly in their handlers. One set of vars → rig + camera.
      if (lookMode() === 'gyro' && gyroActive) {
        yaw += shortAngle(gyroTarget.yaw - yaw) * GYRO_LERP;
        pitch += (gyroTarget.pitch - pitch) * GYRO_LERP;
      }
      rig.rotation.y = yaw;
      camera.rotation.x = pitch;

      // One movement path for WASD + joystick.
      let ix = moveInput.x;
      let iz = moveInput.z;
      if (keys.has('KeyW') || keys.has('ArrowUp'))    iz += 1;
      if (keys.has('KeyS') || keys.has('ArrowDown'))  iz -= 1;
      if (keys.has('KeyD') || keys.has('ArrowRight')) ix += 1;
      if (keys.has('KeyA') || keys.has('ArrowLeft'))  ix -= 1;

      const mag = Math.hypot(ix, iz);
      if (mag > 1) { ix /= mag; iz /= mag; }

      if (ix !== 0 || iz !== 0) {
        _forward.set(0, 0, -1).applyAxisAngle(UP, yaw);
        _right.set(1, 0, 0).applyAxisAngle(UP, yaw);
        const step = MOVE_SPEED * dt;
        rig.position.addScaledVector(_forward, iz * step);
        rig.position.addScaledVector(_right, ix * step);
      }
    }

    applyConstraint();
  }

  function applyConstraint() {
    if (!constrain) return;
    const c = constrain(rig.position.x, rig.position.z);
    rig.position.set(c.x, c.y, c.z);
    if (c.hit && onBoundary) onBoundary();
  }

  // Read Quest thumbsticks: right stick = move (head-relative), left stick = snap-turn.
  function readVRSticks(dt, renderer) {
    const session = renderer.xr.getSession();
    if (!session) return;
    const headYaw = headYawOf(renderer);

    for (const src of session.inputSources) {
      const gp = src.gamepad;
      if (!gp || gp.axes.length < 4) continue;
      const x = gp.axes[2] ?? 0;
      const y = gp.axes[3] ?? 0;

      if (src.handedness === 'right') {
        if (Math.abs(x) > 0.15 || Math.abs(y) > 0.15) {
          _forward.set(0, 0, 1).applyAxisAngle(UP, headYaw);
          _right.set(1, 0, 0).applyAxisAngle(UP, headYaw);
          const step = MOVE_SPEED * dt;
          rig.position.addScaledVector(_forward, y * step);
          rig.position.addScaledVector(_right, x * step);
        }
      } else if (src.handedness === 'left') {
        if (Math.abs(x) > 0.7 && !snapCooldown) {
          rig.rotation.y -= Math.sign(x) * SNAP_TURN;
          yaw = rig.rotation.y; // keep flat-look yaw in sync after a snap-turn
          snapCooldown = true;
        } else if (Math.abs(x) < 0.3) {
          snapCooldown = false;
        }
      }
    }
  }

  return { rig, update, setFreeLook, setMoveInput };
}

const UP = new THREE.Vector3(0, 1, 0);
const clampPitch = (p) => Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, p));
const shortAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a)); // wrap to [-π, π]

// Current screen orientation angle in degrees (portrait 0, landscape ±90).
function screenAngle() {
  if (screen.orientation && typeof screen.orientation.angle === 'number') return screen.orientation.angle;
  return typeof window.orientation === 'number' ? window.orientation : 0;
}

// Head yaw of the XR camera, for head-relative VR movement.
const _q = new THREE.Quaternion();
const _e = new THREE.Euler(0, 0, 0, 'YXZ');
function headYawOf(renderer) {
  renderer.xr.getCamera().getWorldQuaternion(_q);
  _e.setFromQuaternion(_q, 'YXZ');
  return _e.y;
}

// Device-orientation → world quaternion (the standard Three.js DeviceOrientation
// math). alpha/beta/gamma + screen orient (orient) are radians. Scratch reused.
const _gq = new THREE.Quaternion();
const _ge = new THREE.Euler(0, 0, 0, 'YXZ');
const _zee = new THREE.Vector3(0, 0, 1);
const _q0 = new THREE.Quaternion();
const _q1 = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5)); // -90° about X
const _devEuler = new THREE.Euler();
function deviceQuaternion(out, alpha, beta, gamma, orient) {
  _devEuler.set(beta, alpha, -gamma, 'YXZ'); // device frame
  out.setFromEuler(_devEuler);
  out.multiply(_q1);                                 // camera looks out the back
  out.multiply(_q0.setFromAxisAngle(_zee, -orient)); // adjust for screen orientation
  return out;
}
