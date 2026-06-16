import * as THREE from 'three';

// room/zones.js — the ONE source of truth for the room's spatial layout + the
// movement rules that depend on it. scene.js builds meshes from these constants,
// locomotion clamps the player to them, and Phase 3's zap/request queue will reuse
// the same zones (who may stand where) without redefining anything.
//
// Three zones, all keyed off the stage:
//   • STAGE      — the raised platform top. Speakers stand here.
//   • GREEN ROOM — the enclosed walkable space UNDER the stage. Only the designated
//                  next-up (Phase 3; ?slot=next placeholder for now) may be here.
//   • AUDIENCE   — the floor in front of/around the stage. Everyone else.
//
// All units are metres.

// Stage centre, world space.
export const STAGE_POS = new THREE.Vector3(0, 0, -7);

// ── Tunable stage dimensions (A1) ───────────────────────────────────────────────
export const STAGE_RADIUS = 4.5;  // wider + deeper than the old 3.0
export const STAGE_TOP_Y  = 2.4;  // raised high enough to walk underneath
export const STAGE_THICK  = 0.4;  // platform slab thickness

// Outer edge of the audience floor (soft world bound).
export const AUDIENCE_RADIUS = 20;

// Keep bodies this far inside an edge they're confined to (and this far outside an
// edge they're kept away from), so the capsule doesn't visually clip the wall.
export const BODY_MARGIN = 0.5;

// ── Backdrop screen (A1): larger, framed, behind + above the stage ──────────────
export const SCREEN = {
  w: 13,
  h: 7.3,
  y: STAGE_TOP_Y + 3.85,                 // sits above the stage
  z: STAGE_POS.z - STAGE_RADIUS - 0.4,   // just behind the stage's back
};

// ── Pedestal / mic spot (A3): beside the front of the stage ─────────────────────
// The marked place the next-up gets "called up" to (call-up logic is Phase 3).
export const PEDESTAL_POS = new THREE.Vector3(
  STAGE_POS.x + 2.4,
  0,
  STAGE_POS.z + STAGE_RADIUS + 0.9,
);

// ── Movement clamp ───────────────────────────────────────────────────────────────
// constrainPosition(who, x, z) → { x, z, y, hit }
//   who: { role:'speaker'|'listener', isNextUp:boolean }
//   returns the clamped ground position, the floor height for that zone, and
//   whether a boundary was hit this call (so the caller can flash the edge).
export function constrainPosition(who, x, z) {
  const dx = x - STAGE_POS.x;
  const dz = z - STAGE_POS.z;
  const dist = Math.hypot(dx, dz) || 1e-6;

  // Speaker: confined to the stage TOP (inside the disc), standing at STAGE_TOP_Y.
  if (who.role === 'speaker') {
    const max = STAGE_RADIUS - BODY_MARGIN;
    return clampInside(dx, dz, dist, max, STAGE_TOP_Y);
  }

  // Next-up: confined to the GREEN ROOM (inside the disc) at floor level.
  if (who.isNextUp) {
    const max = STAGE_RADIUS - BODY_MARGIN;
    return clampInside(dx, dz, dist, max, 0);
  }

  // Audience: kept OUT of the stage/green-room footprint, inside the outer bound,
  // and in front of the stage (never behind the back wall).
  let hit = false;
  const min = STAGE_RADIUS + BODY_MARGIN;
  if (dist < min) { const k = min / dist; x = STAGE_POS.x + dx * k; z = STAGE_POS.z + dz * k; hit = true; }
  // outer world bound (recompute from the possibly-pushed position)
  const ox = x - STAGE_POS.x, oz = z - STAGE_POS.z;
  const od = Math.hypot(ox, oz);
  if (od > AUDIENCE_RADIUS) { const k = AUDIENCE_RADIUS / od; x = STAGE_POS.x + ox * k; z = STAGE_POS.z + oz * k; hit = true; }
  // stay in front of the stage centre (don't wander behind the back wall)
  if (z < STAGE_POS.z) { z = STAGE_POS.z; hit = true; }

  return { x, z, y: 0, hit };
}

// Clamp a point to within `max` radius of the stage centre, at floor height `y`.
function clampInside(dx, dz, dist, max, y) {
  if (dist > max) {
    const k = max / dist;
    return { x: STAGE_POS.x + dx * k, z: STAGE_POS.z + dz * k, y, hit: true };
  }
  return { x: STAGE_POS.x + dx, z: STAGE_POS.z + dz, y, hit: false };
}

// The boundary ring to glow when `who` hits their limit: { radius, y } centred on
// the stage. (The audience's outer/back limits are soft; we show the meaningful
// stage-footprint edge.)
export function boundaryFor(who) {
  if (who.role === 'speaker') return { radius: STAGE_RADIUS - BODY_MARGIN, y: STAGE_TOP_Y + 0.05 };
  if (who.isNextUp)           return { radius: STAGE_RADIUS - BODY_MARGIN, y: 0.06 };
  return { radius: STAGE_RADIUS + BODY_MARGIN, y: 0.06 };
}
