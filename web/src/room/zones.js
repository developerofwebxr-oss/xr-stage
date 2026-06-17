import * as THREE from 'three';

// room/zones.js — the ONE source of truth for the room's spatial layout + the
// movement rules that depend on it. scene.js builds meshes from these constants,
// locomotion clamps the player to them, and Phase 3's request-to-speak flow reuses
// the same zones (who may stand where) without redefining anything.
//
// Three places a person can be:
//   • STAGE     — the (low, solid) platform top. Speakers stand here.
//   • MIC STAND — the questioner's spot on the floor in front of the stage. The
//                 designated next-up is sent here (Phase 3; ?slot=next for now).
//   • AUDIENCE  — the floor in front of/around the stage. Everyone else.
//
// All units are metres.

// Stage centre, world space.
export const STAGE_POS = new THREE.Vector3(0, 0, -7);

// ── Tunable stage dimensions ──────────────────────────────────────────────────
export const STAGE_RADIUS = 4.5;  // wide, shallow disc
export const STAGE_TOP_Y  = 0.5;  // low + SOLID — sits just off the floor, no cavity

// Outer edge of the audience floor (soft world bound).
export const AUDIENCE_RADIUS = 20;

// Keep bodies this far inside an edge they're confined to (and this far outside an
// edge they're kept away from), so the capsule doesn't visually clip the wall.
export const BODY_MARGIN = 0.5;

// ── Backdrop screen: larger, framed, behind + above the stage ───────────────────
export const SCREEN = {
  w: 13,
  h: 7.3,
  y: STAGE_TOP_Y + 4.6,                  // sits above the stage
  z: STAGE_POS.z - STAGE_RADIUS - 0.4,   // just behind the stage's back
};

// ── Mic stand: the questioner's spot, on the floor beside the front of the stage ─
// The next-up is sent here to talk to the speaker (call-up logic is Phase 3).
export const PEDESTAL_POS = new THREE.Vector3(
  STAGE_POS.x + 2.4,
  0,
  STAGE_POS.z + STAGE_RADIUS + 0.9,
);
// How far the questioner may stray from the mic stand.
export const MIC_RADIUS = 1.1;

// ── Movement clamp ───────────────────────────────────────────────────────────────
// constrainPosition(who, x, z) → { x, z, y, hit }
//   who: { role:'speaker'|'listener', isNextUp:boolean }
//   returns the clamped ground position, the floor height for that zone, and
//   whether a boundary was hit this call (so the caller can flash the edge).
export function constrainPosition(who, x, z) {
  // Speaker: confined to the stage TOP (inside the disc), standing at STAGE_TOP_Y.
  if (who.role === 'speaker') {
    return clampInside(STAGE_POS, x, z, STAGE_RADIUS - BODY_MARGIN, STAGE_TOP_Y);
  }

  // Next-up: confined to a small spot at the mic stand, on the floor.
  if (who.isNextUp) {
    return clampInside(PEDESTAL_POS, x, z, MIC_RADIUS, 0);
  }

  // Audience: kept OUT of the stage footprint, inside the outer bound, and in front
  // of the stage (never wandering round the back).
  let hit = false;
  const dx = x - STAGE_POS.x, dz = z - STAGE_POS.z;
  const dist = Math.hypot(dx, dz) || 1e-6;
  const min = STAGE_RADIUS + BODY_MARGIN;
  if (dist < min) { const k = min / dist; x = STAGE_POS.x + dx * k; z = STAGE_POS.z + dz * k; hit = true; }
  const ox = x - STAGE_POS.x, oz = z - STAGE_POS.z;
  const od = Math.hypot(ox, oz);
  if (od > AUDIENCE_RADIUS) { const k = AUDIENCE_RADIUS / od; x = STAGE_POS.x + ox * k; z = STAGE_POS.z + oz * k; hit = true; }
  if (z < STAGE_POS.z) { z = STAGE_POS.z; hit = true; }

  return { x, z, y: 0, hit };
}

// Clamp a point to within `max` radius of `centre` (a Vector3), at floor height `y`.
function clampInside(centre, x, z, max, y) {
  const dx = x - centre.x, dz = z - centre.z;
  const dist = Math.hypot(dx, dz) || 1e-6;
  if (dist > max) {
    const k = max / dist;
    return { x: centre.x + dx * k, z: centre.z + dz * k, y, hit: true };
  }
  return { x, z, y, hit: false };
}

// The boundary ring to glow when `who` hits their limit: { centre, radius, y }.
export function boundaryFor(who) {
  if (who.role === 'speaker') return { centre: STAGE_POS, radius: STAGE_RADIUS - BODY_MARGIN, y: STAGE_TOP_Y + 0.05 };
  if (who.isNextUp)           return { centre: PEDESTAL_POS, radius: MIC_RADIUS, y: 0.06 };
  return { centre: STAGE_POS, radius: STAGE_RADIUS + BODY_MARGIN, y: 0.06 };
}
