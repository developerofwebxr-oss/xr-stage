import * as THREE from 'three';

// room/zones.js — the ONE source of truth for the room's spatial layout + the
// movement rules that depend on it. scene.js builds meshes from these constants,
// locomotion clamps the player to them, and Phase 3's request-to-speak flow reuses
// the same zones (who may stand where) without redefining anything.
//
// The stage is a TWO-LEVEL connected structure:
//   • MAIN STAGE  — a raised disc (top at STAGE_TOP_Y). Speakers stand here.
//   • MIC PLATFORM — a lower rectangular landing joined to the FRONT of the stage,
//                    one step down, holding the mic. The next-up/questioner stands
//                    here (in front of the mic) facing up to the speaker.
//   • AUDIENCE    — the floor in front, around the structure. Everyone else.
//
// All units are metres.

// Stage centre, world space.
export const STAGE_POS = new THREE.Vector3(0, 0, -7);
export const STAGE_RADIUS = 4.5;

// ── Tunable heights ──────────────────────────────────────────────────────────
export const STAGE_TOP_Y       = 1.0;                          // main-stage height (raised)
export const STEP_HEIGHT       = 0.4;                          // one step down to the mic platform
export const MIC_PLATFORM_TOP  = STAGE_TOP_Y - STEP_HEIGHT;    // 0.6

// ── Tunable mic-platform footprint (a rectangle in front of the stage) ──────────
export const MIC_PLATFORM_W     = 4.2;   // width (x) — a touch narrower
export const MIC_PLATFORM_DEPTH = 3.0;   // forward reach from the stage front — a touch shorter
export const STAND_CLEARANCE    = 1.3;   // standing room in front of the mic
const PLATFORM_OVERLAP = 0.8;            // how far the platform tucks under the stage (joins them)

// Outer edge of the audience floor (soft world bound). Sized so the social-zone BUILDINGS
// deep behind the audience (Smoking park-gate / Networking hall — see zones/zones.js) are
// comfortably reachable — a real courtyard walk from the stage. This is the ONE clamp radius
// everything else (floor disc + rings, scene) derives from.
export const AUDIENCE_RADIUS = 38;

// The avatar's body radius. Clamps offset edges by THIS so a capsule (radius ~0.28)
// stops flush against a wall/edge and never overlaps the mesh — a small epsilon
// over the true radius guarantees no clipping from any approach.
export const BODY_RADIUS = 0.32;

// ── Derived layout ──────────────────────────────────────────────────────────────
const STAGE_FRONT_Z = STAGE_POS.z + STAGE_RADIUS;                 // -2.5 (frontmost stage point)
export const MIC_PLATFORM_BACK_Z  = STAGE_FRONT_Z - PLATFORM_OVERLAP;       // tucks under the stage
export const MIC_PLATFORM_FRONT_Z = STAGE_FRONT_Z + MIC_PLATFORM_DEPTH;     // front edge

// Mic stand: on the platform, near the stage; questioner stands in front of it.
export const MIC_STAND_POS = new THREE.Vector3(STAGE_POS.x, MIC_PLATFORM_TOP, STAGE_FRONT_Z + 0.45);
export const QUESTIONER_POS = new THREE.Vector3(STAGE_POS.x, MIC_PLATFORM_TOP, MIC_STAND_POS.z + STAND_CLEARANCE);

// Where the questioner may stand: the exposed platform top, in front of the stage,
// inset by the body radius so the capsule never overhangs an edge.
const NEXTUP_X_HALF = MIC_PLATFORM_W / 2 - BODY_RADIUS;
const NEXTUP_Z_MIN  = STAGE_FRONT_Z + BODY_RADIUS;            // just in front of the stage step
const NEXTUP_Z_MAX  = MIC_PLATFORM_FRONT_Z - BODY_RADIUS;     // just inside the platform front lip

// ── Backdrop screen: larger, framed, behind + above the stage ───────────────────
export const SCREEN = {
  w: 13,
  h: 7.3,
  y: STAGE_TOP_Y + 4.1,                  // sits above the (raised) stage
  z: STAGE_POS.z - STAGE_RADIUS - 0.4,   // just behind the stage's back
};

// ── Backstage green room (4.5): an enclosed room BEHIND the screen wall, reached down a
// stage-LEFT approach lane. Speakers-only (backstageAccess); non-holders are walled out at
// the stage-front line, so the interior never leaks to the plaza. Floor level (y=0). ────
export const BACKSTAGE = { cx: -1.0, cz: -15.0, w: 8.0, d: 5.0, h: 3.0, doorHalf: 0.9 };
const BS_XMIN = BACKSTAGE.cx - BACKSTAGE.w / 2, BS_XMAX = BACKSTAGE.cx + BACKSTAGE.w / 2; // -5 .. 3
const BS_ZMIN = BACKSTAGE.cz - BACKSTAGE.d / 2, BS_ZMAX = BACKSTAGE.cz + BACKSTAGE.d / 2; // -17.5 .. -12.5
export const BACKSTAGE_DOOR = { x: BS_XMIN, z: BACKSTAGE.cz };  // door in the −x (stage-left) wall
// Approach lane: a corridor stage-LEFT of the disc joining the plaza to the room door.
const LANE_XMIN = -7.0, LANE_XMAX = -5.0, LANE_ZMIN = BS_ZMAX - 0.5, LANE_ZMAX = -3.0;
// Detection centre (for the zone pill/audio) — inside the room.
export const BACKSTAGE_CENTER = { x: BACKSTAGE.cx, z: BACKSTAGE.cz, r: 3.0 };

const inRect = (x, z, x0, x1, z0, z1) => x >= x0 && x <= x1 && z >= z0 && z <= z1;
// Keep a backstage holder inside the L-shaped yard (lane ∪ room), at floor level. Rough but
// contiguous through the door seam (the rects overlap there).
function clampYard(x, z) {
  const r = BODY_RADIUS;
  const inLane = inRect(x, z, LANE_XMIN, LANE_XMAX, LANE_ZMIN, LANE_ZMAX);
  const inRoom = inRect(x, z, BS_XMIN + r, BS_XMAX - r, BS_ZMIN + r, BS_ZMAX - r);
  if (inLane || inRoom) return { x, z, hit: false };
  if (z > BS_ZMAX - r) {                                   // up in the lane column → lane clamp
    return { x: clamp(x, LANE_XMIN, LANE_XMAX), z: clamp(z, LANE_ZMIN, LANE_ZMAX), hit: true };
  }
  return { x: clamp(x, BS_XMIN + r, BS_XMAX - r), z: clamp(z, BS_ZMIN + r, BS_ZMAX - r), hit: true };
}
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

// ── Movement clamp ───────────────────────────────────────────────────────────────
// constrainPosition(who, x, z, ar=false) → { x, z, y, hit }
//   who: { role:'speaker'|'listener', isNextUp:boolean }
//   ar:  AR passthrough — the bounded room is gone (shell-off), so swap the room
//        BOUNDS (outer audience radius + the in-front-of-stage wall) for PER-PROP
//        collision only: the player still can't walk through the stage or mic
//        platform, but is free to roam the real room beyond the venue footprint.
// Every edge is offset by BODY_RADIUS so the avatar stops cleanly against geometry
// (kept inside by the radius; pushed outside by the radius) — no mesh clipping.
export function constrainPosition(who, x, z, ar = false) {
  // Stage-role = any event speaker (URL ?role=speaker OR a granted speaker pass, main sets
  // who.speaker). Backstage = holders of backstageAccess (speakers). These extend, not
  // replace, the audience model: speakers may STEP onto the raised stage (chairs live there
  // for panels) and roam off it; backstage holders may pass behind into the green room.
  const stageRole = who.role === 'speaker' || who.speaker;
  const canBackstage = !!who.backstage;

  // Backstage yard (green room + its stage-left lane) — holders only, floor level.
  if (canBackstage && z < STAGE_POS.z && inYard(x, z)) {
    const c = clampYard(x, z);
    return { x: c.x, z: c.z, y: 0, hit: c.hit };
  }

  // Next-up: confined to the MIC PLATFORM standing area, at MIC_PLATFORM_TOP.
  if (who.isNextUp) {
    let hit = false;
    const minX = STAGE_POS.x - NEXTUP_X_HALF, maxX = STAGE_POS.x + NEXTUP_X_HALF;
    if (x < minX) { x = minX; hit = true; } else if (x > maxX) { x = maxX; hit = true; }
    if (z < NEXTUP_Z_MIN) { z = NEXTUP_Z_MIN; hit = true; } else if (z > NEXTUP_Z_MAX) { z = NEXTUP_Z_MAX; hit = true; }
    return { x, z, y: MIC_PLATFORM_TOP, hit };
  }

  // Audience / off-stage. Stage-role players may STAND on the raised stage disc (y rises to
  // the top — chairs sit here for panels); everyone else is pushed off it. Mic-platform +
  // outer bounds + front-of-stage wall as before.
  let hit = false;
  const dx = x - STAGE_POS.x, dz = z - STAGE_POS.z;
  const dist = Math.hypot(dx, dz) || 1e-6;
  let y = 0;
  if (stageRole) {
    if (dist <= STAGE_RADIUS - BODY_RADIUS) y = STAGE_TOP_Y;   // standing on the stage top
  } else {
    const min = STAGE_RADIUS + BODY_RADIUS;
    if (dist < min) { const k = min / dist; x = STAGE_POS.x + dx * k; z = STAGE_POS.z + dz * k; hit = true; }

    // Push off the mic-platform footprint (audience only) — nearest of front/left/right.
    const pMinX = STAGE_POS.x - MIC_PLATFORM_W / 2 - BODY_RADIUS;
    const pMaxX = STAGE_POS.x + MIC_PLATFORM_W / 2 + BODY_RADIUS;
    const pMaxZ = MIC_PLATFORM_FRONT_Z + BODY_RADIUS;
    if (x > pMinX && x < pMaxX && z > MIC_PLATFORM_BACK_Z && z < pMaxZ) {
      const dFront = pMaxZ - z, dLeft = x - pMinX, dRight = pMaxX - x;
      const m = Math.min(dFront, dLeft, dRight);
      if (m === dFront) z = pMaxZ; else if (m === dLeft) x = pMinX; else x = pMaxX;
      hit = true;
    }
  }

  // Room BOUNDS (outer radius + the front-of-stage wall) — dropped in AR. The front wall
  // opens for backstage holders in the stage-LEFT lane mouth (their route behind).
  if (!ar) {
    const ox = x - STAGE_POS.x, oz = z - STAGE_POS.z;
    const od = Math.hypot(ox, oz);
    if (od > AUDIENCE_RADIUS) { const k = AUDIENCE_RADIUS / od; x = STAGE_POS.x + ox * k; z = STAGE_POS.z + oz * k; hit = true; }
    const inLaneMouth = canBackstage && x > LANE_XMIN && x < LANE_XMAX;
    if (z < STAGE_POS.z && !inLaneMouth) { z = STAGE_POS.z; hit = true; }
  }

  return { x, z, y, hit };
}

// Inside the L-shaped backstage yard (lane ∪ room)?
function inYard(x, z) {
  const r = BODY_RADIUS;
  return inRect(x, z, LANE_XMIN, LANE_XMAX, LANE_ZMIN, LANE_ZMAX)
      || inRect(x, z, BS_XMIN + r, BS_XMAX - r, BS_ZMIN + r, BS_ZMAX - r);
}

function clampInsideCircle(centre, x, z, max, y) {
  const dx = x - centre.x, dz = z - centre.z;
  const dist = Math.hypot(dx, dz) || 1e-6;
  if (dist > max) { const k = max / dist; return { x: centre.x + dx * k, z: centre.z + dz * k, y, hit: true }; }
  return { x, z, y, hit: false };
}

// The boundary to glow when `who` hits their limit.
//   speaker/audience → a ring on the stage edge; next-up → the mic-platform rect.
export function boundaryFor(who) {
  if (who.role === 'speaker') {
    return { shape: 'ring', centre: STAGE_POS, radius: STAGE_RADIUS - BODY_RADIUS, y: STAGE_TOP_Y + 0.05 };
  }
  if (who.isNextUp) {
    const centre = new THREE.Vector3(STAGE_POS.x, 0, (NEXTUP_Z_MIN + NEXTUP_Z_MAX) / 2);
    return { shape: 'rect', centre, w: NEXTUP_X_HALF * 2, d: NEXTUP_Z_MAX - NEXTUP_Z_MIN, y: MIC_PLATFORM_TOP + 0.05 };
  }
  return { shape: 'ring', centre: STAGE_POS, radius: STAGE_RADIUS + BODY_RADIUS, y: 0.06 };
}
