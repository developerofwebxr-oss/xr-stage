import * as THREE from 'three';
import { comfort } from '../input/comfort.js';
import { config } from '../config.js';

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
// createLocomotion() returns { rig, update, setFreeLook, setMoveInput, jump, toggleFly }.
// update(dt, renderer) runs every frame (reads VR thumbsticks when immersive).

// Movement speeds are FIXED, not a comfort toggle (per the standard). Analog inputs
// (VR stick, mobile joystick) sprint by MAGNITUDE — full deflection past SPRINT_EDGE
// → run; the keyboard, being digital, sprints with Shift.
const WALK_SPEED = 1.4;          // metres/sec — normal pace
const SPRINT_SPEED = 2.8;        // metres/sec — full-push / Shift
// Analog sprint threshold. A Quest thumbstick at full push rarely reports magnitude near
// 1.0 — the runtime's radial scaling tops it out around ~0.85–0.95 — so a 0.92 bar was
// effectively unreachable and sprint never engaged (walk scaling just maxed out under it).
// 0.85 leaves headroom: full push sprints, everything below stays fine-grained walk.
const SPRINT_EDGE = 0.85;        // analog magnitude at/above which we sprint
const WALK_PLATEAU = 0.6;        // magnitude at which analog reaches full WALK_SPEED (below = fine control)
const SMOOTH_TURN_SPEED = 2.4;   // rad/sec — default continuous right-stick turn
const SNAP_TURN = Math.PI / 6;   // 30° per flick — opt-in comfort (comfort.snapTurn)
const LOOK_SENSITIVITY = 0.0022; // pointer-lock radians per mouse pixel
const DRAG_SENSITIVITY = 0.0035; // hold/touch-drag radians per pixel
const PITCH_LIMIT = Math.PI / 2 - 0.05;
const GYRO_LERP = 0.12;                          // low-pass toward the gyro target
const GYRO_DEADZONE = THREE.MathUtils.degToRad(0.6); // ignore sub-degree sensor jitter
const FLY_SPEED = 3.2;           // metres/sec while flying (ENABLE_FLY only)
// Jump: a modest hop for presence/expression, not a platformer leap. v²/2g ≈ 0.4m
// peak, ~0.57s airtime — gentle enough for VR comfort.
const JUMP_SPEED = 2.8;          // initial upward velocity (m/s)
const GRAVITY = 9.8;             // downward accel while airborne (m/s²)

// ONE analog speed curve for every analog input (VR left stick + mobile joystick): fine
// control that reaches full walk by WALK_PLATEAU, then a clean step to sprint at SPRINT_EDGE.
// Keeping this shared is what keeps the "one locomotion path" promise across realities.
const analogSpeed = (mag) => (mag >= SPRINT_EDGE ? SPRINT_SPEED : WALK_SPEED * Math.min(1, mag / WALK_PLATEAU));

// xr-standard gamepad map (queried by index; see the skill's Controller & Input
// Standard). The hardware Menu/System buttons are NOT in this list — the platform
// reserves them, so in-app pause/exit lives on Left X.
const BTN = { TRIGGER: 0, GRIP: 1, STICK: 3, PRIMARY: 4, SECONDARY: 5 }; // A/X = PRIMARY, B/Y = SECONDARY

// `constrain(x, z) -> { x, z, y, hit }` keeps the rig inside its zone every frame;
// `onBoundary()` fires the frame a limit is hit. `isMobile` picks the Free-look
// mechanism (gyro vs pointer-lock). `onFreeLookEnd()` fires if pointer lock exits
// on its own (e.g. Esc) so the UI can untoggle.
//
// Verb callbacks (bound identically on VR buttons + desktop keys, per the cross-input
// parity table): onMenu (X / Esc·M), onGrab (grip / E-hold·right-click), onVerbB
// (B / B-key — this game: toggle mic), onVerbY (Y / Y-key — this game: zap).
export function createLocomotion(camera, domElement, {
  spawn, constrain, onBoundary, isMobile = false, onFreeLookEnd,
  onMenu = () => {}, onGrab = () => {}, onVerbB = () => {}, onVerbY = () => {}, onEmote = () => {},
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
  let sprintHeld = false;           // mobile Move-accordion hold-to-run (4.18): forces sprint speed
  let paused = false;               // AFK pause (4.18): halts locomotion + jump input

  // Jump state (Screen + VR + AR — enabled in every mode). One hop at a
  // time: `airborne` blocks re-trigger until we land. `jumpHeight` is added ABOVE
  // the clamped surface y in applyConstraint, so the horizontal boundaries/clamps
  // and the tiered landing surface (floor / mic platform / stage) are untouched —
  // jump is purely vertical.
  let jumpQueued = false, airborne = false, jumpHeight = 0, vy = 0;
  let spaceHeld = false;
  let _reassert = 0; // frames to re-assert the flat camera reset after an immersive exit (4.3)

  // Fly (ENABLE_FLY only): "fly where you look" — a single toggle, no separate up/down
  // controls (look up + move = ascend). Off → behaves exactly as the grounded path.
  let flying = false;

  // VR button edge-tracking: fire a verb once per press (not every frame it's held).
  const vrPrev = {};
  const vrEdge = (key, pressed) => { const was = vrPrev[key]; vrPrev[key] = pressed; return pressed && !was; };

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

  // Keyboard = the desktop half of the cross-input parity table. Movement keys live
  // in `keys`; the verb keys map to the SAME callbacks/actions as the VR buttons so a
  // verb is never improvised per-platform.
  addEventListener('keydown', (e) => {
    // Never hijack typing: while an editable element has focus (input / textarea /
    // contenteditable), suppress ALL game/locomotion keys — Space, WASD, E, F, M, Esc-menu
    // — so a space types a space, not a jump. Guarded centrally here (the one game key
    // handler) rather than per-field. keyup is NOT guarded, so any key pressed before the
    // field took focus still clears. (Skill: webxr-threejs input.)
    if (isEditable(e.target) || isEditable(document.activeElement)) return;
    if (e.code === 'Space') {                      // Jump (parity: A / Space / jump btn)
      e.preventDefault();                          // don't scroll the page
      if (!spaceHeld) { spaceHeld = true; jumpQueued = true; } // edge: one jump per press
      return;
    }
    if (e.repeat) return;                          // verb keys fire once per press
    switch (e.code) {
      case 'KeyF': toggleFly(); return;            // Fly (parity: right-stick click / F)
      case 'KeyE': onGrab(); return;               // Grab primary (parity: grip / E-hold)
      case 'KeyB': onVerbB(); return;              // Game verb B (this game: toggle mic)
      case 'KeyY': onVerbY(); return;              // Game verb Y (this game: zap)
      case 'KeyM': onMenu(); return;               // Menu alias (parity: X / Esc·M / ☰)
      case 'Digit1': onEmote('wave'); return;      // Emotes (4.8) — guarded by the editable-focus check above
      case 'Digit2': onEmote('clap'); return;
      case 'Digit3': onEmote('thumbsup'); return;
      case 'Digit4': onEmote('point'); return;
      case 'Escape':
        // Esc is the PRIMARY desktop menu key — but when pointer-locked the browser
        // consumes it to release the lock (handled by pointerlockchange). Only open
        // the menu when we're not in that capture.
        if (document.pointerLockElement !== domElement) onMenu();
        return;
    }
    keys.add(e.code);                              // movement keys (WASD/arrows/Shift)
  });
  addEventListener('keyup', (e) => {
    if (e.code === 'Space') { spaceHeld = false; return; }
    keys.delete(e.code);
  });

  // Grab alias on the desktop pointer: right-click (parity: grip / right-click). Kill
  // the context menu so the right-button press reads as a grab, not a browser menu.
  domElement.addEventListener('contextmenu', (e) => { e.preventDefault(); onGrab(); });

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
  const _flyEuler = new THREE.Euler(0, 0, 0, 'YXZ');
  let snapCooldown = false;

  // ── update ────────────────────────────────────────────────────────────────────
  function update(dt, renderer) {
    const immersive = renderer.xr.isPresenting;

    if (immersive) {
      readVRSticks(dt, renderer);
    } else {
      // Just exited immersive: re-assert the full flat camera reset for a few frames so any
      // XR matrix Three writes on the teardown frames can't leave a residual roll/offset.
      if (_reassert > 0) {
        _reassert--;
        camera.matrixAutoUpdate = true;
        camera.position.set(0, 1.6, 0);
        camera.rotation.set(pitch, 0, 0);   // pitch only — zero yaw + ROLL
      }
      // Gyro look low-passes toward its target; drag/pointer-lock already wrote
      // yaw/pitch directly in their handlers. One set of vars → rig + camera.
      if (lookMode() === 'gyro' && gyroActive) {
        yaw += shortAngle(gyroTarget.yaw - yaw) * GYRO_LERP;
        pitch += (gyroTarget.pitch - pitch) * GYRO_LERP;
      }
      rig.rotation.y = yaw;
      camera.rotation.x = pitch;

      // One movement path for WASD (digital) + joystick (analog), merged. Analog
      // sprints by MAGNITUDE (full push → run); the keyboard sprints with Shift.
      const joyMag = Math.hypot(moveInput.x, moveInput.z);
      let ix = moveInput.x;
      let iz = moveInput.z;
      let kx = 0, kz = 0;
      if (keys.has('KeyW') || keys.has('ArrowUp'))    kz += 1;
      if (keys.has('KeyS') || keys.has('ArrowDown'))  kz -= 1;
      if (keys.has('KeyD') || keys.has('ArrowRight')) kx += 1;
      if (keys.has('KeyA') || keys.has('ArrowLeft'))  kx -= 1;
      const kbActive = kx !== 0 || kz !== 0;
      ix += kx; iz += kz;

      const mag = Math.hypot(ix, iz);
      if (mag > 1) { ix /= mag; iz /= mag; }

      if ((ix !== 0 || iz !== 0) && !paused) {
        const shift = keys.has('ShiftLeft') || keys.has('ShiftRight');
        // Digital (keyboard) sprints with Shift; analog (joystick) sprints by magnitude
        // through the shared curve — the SAME analogSpeed() the VR stick uses. The mobile
        // Move-accordion Sprint button (sprintHeld) forces run speed while held (4.18).
        let speed;
        if (flying) speed = FLY_SPEED;
        else if (kbActive) speed = shift ? SPRINT_SPEED : WALK_SPEED;
        else speed = sprintHeld ? SPRINT_SPEED : analogSpeed(joyMag);
        const step = speed * dt;

        // "Fly where you look": when flying, forward follows the camera pitch so
        // look-up + move ascends — no separate up/down keys. Grounded: heading only.
        if (flying) _forward.set(0, 0, -1).applyEuler(_flyEuler.set(pitch, yaw, 0, 'YXZ'));
        else _forward.set(0, 0, -1).applyAxisAngle(UP, yaw);
        _right.set(1, 0, 0).applyAxisAngle(UP, yaw);
        rig.position.addScaledVector(_forward, iz * step);
        rig.position.addScaledVector(_right, ix * step);
      }
    }

    updateJump(dt);
    applyConstraint();
  }

  // Integrate the hop. Horizontal x/z is already settled above; this only touches
  // the vertical offset. Jump is enabled in ALL immersive modes now — AR included
  // (owner-requested, same modest hop as VR); landing height still resolves via the
  // surface-aware `constrain` callback, so an AR hop returns to the real floor.
  function updateJump(dt) {
    if (jumpQueued) {
      jumpQueued = false;
      if (!airborne) { vy = JUMP_SPEED; airborne = true; }
    }
    if (airborne) {
      jumpHeight += vy * dt;
      vy -= GRAVITY * dt;
      if (jumpHeight <= 0) { jumpHeight = 0; vy = 0; airborne = false; } // landed
    }
  }

  function applyConstraint() {
    if (!constrain) return;
    const c = constrain(rig.position.x, rig.position.z);
    if (flying) {
      // Free vertical while flying; still clamp XZ to the zone and never sink below
      // the surface under us.
      rig.position.set(c.x, Math.max(rig.position.y, c.y), c.z);
    } else {
      // c.y is the surface under our (clamped) XZ — floor / mic platform / stage. The
      // hop rides ON TOP of it, so we always land back on the right tier.
      rig.position.set(c.x, c.y + jumpHeight, c.z);
    }
    if (c.hit && onBoundary) onBoundary();
  }

  // Read Quest controllers per the canonical Controller & Input Standard:
  //   LEFT  stick → move (head-relative, magnitude→speed, full push sprints)
  //   RIGHT stick → turn (smooth by default; snap when comfort.snapTurn)
  //   RIGHT stick click → toggle fly (ENABLE_FLY)
  //   A (right) → jump · X (left) → menu · B (right)/Y (left) → game verbs
  //   grip (both) → grab · trigger (both) → select (handled by the 'select' event)
  // Buttons fire on rising edge (vrEdge) so a held press is one action.
  function readVRSticks(dt, renderer) {
    const session = renderer.xr.getSession();
    if (!session) return;
    const headYaw = headYawOf(renderer);

    for (const src of session.inputSources) {
      const gp = src.gamepad;
      if (!gp) continue;
      const hand = src.handedness; // 'left' | 'right' | 'none'
      const b = gp.buttons || [];
      const x = gp.axes?.[2] ?? 0;
      const y = gp.axes?.[3] ?? 0;

      // ── ?vrdebug readout (4.3 re-fix) — report EXACTLY what the Quest sends per press-edge:
      // hand, button index, and the raw axes (so the real stick range + face-button indices are
      // visible via chrome://inspect). Off unless config.vrDebug. Remove once confirmed on device.
      if (config.vrDebug) {
        if (!hand || hand === 'none') console.warn('[vrbtn] handedness=none — cannot tell A/X or B/Y apart');
        for (let i = 0; i < b.length; i++) {
          if (vrEdge(`dbg:${hand}:${i}`, !!b[i]?.pressed)) {
            console.log(`[vrbtn] hand=${hand} index=${i} pressed · axes=[${(gp.axes || []).map((a) => a.toFixed(2)).join(', ')}]`);
          }
        }
      }

      // Grip = grab on either hand (parity: grip / E-hold·right-click).
      if (vrEdge(hand + ':grip', !!b[BTN.GRIP]?.pressed)) onGrab();

      if (hand === 'left') {
        // Left stick = move (head-relative). Magnitude drives speed; full push sprints.
        const mag = Math.hypot(x, y);
        if (mag > 0.15) {
          const nx = x / mag, ny = y / mag;
          const speed = flying ? FLY_SPEED : analogSpeed(mag); // full push (>= SPRINT_EDGE) → run
          const step = speed * dt;
          if (flying) _forward.set(0, 0, 1).applyEuler(_flyEuler.set(-headPitchOf(renderer), headYaw, 0, 'YXZ'));
          else _forward.set(0, 0, 1).applyAxisAngle(UP, headYaw);
          _right.set(1, 0, 0).applyAxisAngle(UP, headYaw);
          rig.position.addScaledVector(_forward, ny * step);
          rig.position.addScaledVector(_right, nx * step);
        }
        if (vrEdge('L:x', !!b[BTN.PRIMARY]?.pressed)) onMenu();    // X → Pause/Menu
        if (vrEdge('L:y', !!b[BTN.SECONDARY]?.pressed)) onVerbY(); // Y → game verb (zap)
      } else if (hand === 'right') {
        // Right stick X = turn. Smooth (softly-eased) by default; snap is opt-in comfort.
        if (comfort.get('snapTurn')) {
          if (Math.abs(x) > 0.7 && !snapCooldown) {
            rig.rotation.y -= Math.sign(x) * SNAP_TURN;
            yaw = rig.rotation.y;       // keep flat-look yaw in sync after a snap
            snapCooldown = true;
          } else if (Math.abs(x) < 0.3) {
            snapCooldown = false;
          }
        } else if (Math.abs(x) > 0.15) {
          rig.rotation.y -= (x * x * x) * SMOOTH_TURN_SPEED * dt; // cubic ease: gentle near centre
          yaw = rig.rotation.y;
        }
        if (vrEdge('R:a', !!b[BTN.PRIMARY]?.pressed)) jumpQueued = true; // A → jump
        if (vrEdge('R:b', !!b[BTN.SECONDARY]?.pressed)) onVerbB();       // B → game verb (mic)
        if (vrEdge('R:stick', !!b[BTN.STICK]?.pressed)) toggleFly();     // stick click → fly
      }
    }
  }

  // Restore a clean FLAT camera when an immersive session ends. BOTH exit routes — the
  // in-app "Exit to screen" and the platform system-quit — funnel through the same
  // sessionend → onModeChange('flat'), so main calls this once from there.
  //
  // Why it's needed (the sessionend lifecycle footgun): in XR, Three drives the camera's
  // LOCAL transform from the live head pose — a position offset AND full head orientation
  // including PITCH and ROLL. Flat mode only ever writes `rig.rotation.y = yaw` and
  // `camera.rotation.x = pitch`; it never clears the camera's position, yaw, or ROLL. Left
  // unreset, the residual head roll returns as a TILTED view and the head offset as a
  // POSITION shift — every exit. Re-initialise the flat camera state fully here.
  function resetFlatView() {
    camera.matrixAutoUpdate = true;      // XR may have driven the matrix directly — re-enable auto
    camera.up.set(0, 1, 0);              // and a clean up vector (roll lives here if XR baked it)
    camera.position.set(0, 1.6, 0);      // flat eye height, centred on the rig
    camera.quaternion.identity();        // wipe the head orientation…
    camera.rotation.set(pitch, 0, 0);    // …then re-apply flat PITCH only — zero yaw + ROLL
    camera.updateMatrix();
    camera.updateMatrixWorld(true);
    camera.updateProjectionMatrix();     // XR may have overwritten the mono projection
    rig.matrixAutoUpdate = true;
    rig.rotation.set(0, yaw, 0);         // rig owns yaw; clear any stray roll/pitch on it
    rig.updateMatrixWorld(true);
    _reassert = 6;                       // re-assert over the next few flat frames (see update)
  }

  // jump() queues a hop from any input source (the optional mobile button calls it).
  // Same guards as Space/VR apply in updateJump (single hop, all modes).
  function jump() { if (!paused) jumpQueued = true; }
  function setSprint(on) { sprintHeld = !!on; }           // mobile hold-to-run (4.18)
  function setPaused(on) { paused = !!on; if (paused) { moveInput.x = 0; moveInput.z = 0; } } // AFK halt (4.18)

  // toggleFly() — the standard's fly toggle, gated by ENABLE_FLY (config.enableFly).
  // Bound to right-stick click / F key / mobile button; a no-op when the flag is off,
  // so the binding exists on every reality but stays inert for this grounded venue.
  function toggleFly() {
    if (!config.enableFly) return false;
    flying = !flying;
    if (!flying) { jumpHeight = 0; vy = 0; airborne = false; } // re-ground cleanly
    return flying;
  }

  return { rig, update, setFreeLook, setMoveInput, jump, setSprint, setPaused, toggleFly, resetFlatView, isFlying: () => flying };
}

const UP = new THREE.Vector3(0, 1, 0);
// True when a text-entry element has focus — game keys must stand down so typing works.
function isEditable(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true;
}
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
// Head pitch of the XR camera (used only for VR "fly where you look").
function headPitchOf(renderer) {
  renderer.xr.getCamera().getWorldQuaternion(_q);
  _e.setFromQuaternion(_q, 'YXZ');
  return _e.x;
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
