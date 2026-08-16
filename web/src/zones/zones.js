import * as THREE from 'three';
import { STAGE_POS, BACKSTAGE, BACKSTAGE_CENTER } from '../room/zones.js';
import { loadGLB, fitToHeight, measure } from '../room/gltf.js';

// zones/zones.js — the SOCIAL zones as ENCLOSED destination buildings across the plaza behind
// the audience, the detection + access SEAMS, a night FOREST backdrop, and live OCCUPANCY.
//
//   • Networking — a curved-facade HALL, fully enclosed (side + back walls + ceiling), grand +
//     deep. From the plaza you see only the facade + a dark doorway.
//   • Smoking — a park GATE opening into an enclosed CLEARING (hedge perimeter). The gate is the
//     only opening.
//   • Forest — instanced stylized conifers scattered OUTSIDE both interiors (exclusion regions),
//     screening + receding to the horizon; never inside a zone or blocking an entrance/path.
//
//   zones.current()          → the zone the local rig is in, or null
//   zones.onChange(cb)       → subscribe to enter/leave; returns unsub  (cb(zone|null))
//   zones.update(x, z)       → recompute from the rig's XZ; emits only when the zone changes
//   zones.occupancy(id)      → { count, patron, supporter, speaker } for a zone (mock population
//                              + the local player when inside — see setLocalBadge)
//   zones.setLocalBadge(badge, speaker) · zones.refreshOccupancy()
//   buildZoneScenery(scene)  → adds the buildings/gate/clearing/forest/plaques (call once)
//   zoneAnchors              → named refs into each interior for decoration/sponsor mounts
//
// ─── SEAMS (later slices — do NOT wire here) ───────────────────────────────────────────
//  • AUDIO isolation: zones.onChange enter/leave will drive per-zone LiveKit audio groups.
//  • OCCUPANCY (real): presence will broadcast the occupant's zone id with its heartbeat; swap
//    the mock population below for a live tally keyed by that. The shape here won't change.
//  • SPONSOR screens: zoneAnchors.walls (Networking) + the Smoking hedge are the future mounts —
//    keep them clear (nothing decorates the walls yet).
//  • Future paid "Ostrich Farm" zone reuses ZONE_DEFS + accessClamp + this whole system.
// ────────────────────────────────────────────────────────────────────────────────────────

const EMBER = 0xff6a2c;   // Smoking — warm ember
const TEAL  = 0x27c6c6;   // Networking — cool teal
const C = STAGE_POS;      // arc centre = stage centre (0,0,−7)

const onArc = (radius, a) => new THREE.Vector3(C.x + radius * Math.sin(a), 0, C.z + radius * Math.cos(a));
const bearing = (x, z) => Math.atan2(x - C.x, z - C.z);
const radiusOf = (x, z) => Math.hypot(x - C.x, z - C.z);
const shortAng = (d) => Math.atan2(Math.sin(d), Math.cos(d));

// ── Building dimensions (module-level so the forest exclusions can reference them) ──────
// Networking HALL — much wider + deeper than before so the room reads grand. INTERIOR_DEPTH is
// the occupancy-scaling SEAM (static now; a busy hall could grow it live).
const NET_H = 7.0, NET_WALLHALF = 0.30, NET_DOORHALF = 0.055, NET_DEPTH = 22;
// Smoking CLEARING.
const SMK_CW = 11, SMK_CD = 10, SMK_HH = 3.0, SMK_POSTH = 3.6, SMK_GATEHALF = 0.07;
// 🦩 Nostrich Park (4.10 · re-sectored 4.13 #2) — its OWN clear angular sector on the venue ring,
// far-right and past Networking (no more overlap). Open-air (fence perimeter, no ceiling). The front
// barrier is an ARC concentric with the venue circles (same centre C) so the whole venue reads as
// rings; radial fences + the forest close the sides/back. Flock pens + coaster station live inside;
// main builds those. GATE = the entrance GLB, in a gap in the front arc.
// 4.17 #3: front arc pushed OUT to Networking's radius (≈31.5) so all destination buildings sit on
// one ring, with a clear angular GAP from Networking (which spans bearing ≈ −6°…28°). Park sector is
// 35.5°…74.5° → open sky between them. Reachable interior is Ri…AUDIENCE_RADIUS(38); the back arc is
// cosmetic (like Networking's deep hall). Flock pens + coaster station sit in the reachable band.
export const PARK = {
  cx: 25, cz: 13,               // interior centroid (detection); station + pens sit around here
  Ri: 31.5, Ro: 44,             // sector radii — front arc on Networking's ring / cosmetic back
  th0: 0.62, th1: 1.30,         // angular span (bearings from the stage) — clear gap past Networking
  h: 3.0, gateHalfAng: 0.075,   // fence height · gate-gap angular half-width on the front arc
  hue: 0xff5aa8,
};
export const PARK_PENS = [   // fenced sub-areas the flock wanders (in the reachable band, never through guests)
  { x: 20, z: 20, w: 5, d: 5 },
  { x: 28, z: 17, w: 5, d: 5 },
  { x: 30, z: 10, w: 5, d: 5 },
];
const PARK_TH = (PARK.th0 + PARK.th1) / 2;      // gate bearing = front-arc centre
const PARK_GATE = onArc(PARK.Ri, PARK_TH);      // gate world position on the front arc

export const ZONE_DEFS = [
  {
    id: 'smoking', name: 'Smoking Area', emoji: '🚬', hue: EMBER,
    fx: -13, fz: 19,             // park gate, back-left
    cx: -14.1, cz: 21.2, r: 3.2, // detection: inside the clearing (past the gate)
    requires: 'smokingAccess', accessKind: 'smoking',
    lettersText: 'SMOKING AREA', lettersH: 2.0,
    plaque: 'Permissionless talk. The closer you stand, the better you hear. Entry: ticket + mic permission — your mic is ON in here.',
  },
  {
    id: 'networking', name: 'Networking', emoji: '🤝', hue: TEAL,
    fx: 6, fz: 24,               // hall doorway, back centre/right
    cx: 7.04, cz: 29.32, r: 6.0, // detection follows the deeper/wider hall (near edge ≈ the doorway)
    requires: 'networkingAccess', accessKind: 'networking',
    lettersText: 'NETWORKING', lettersH: 2.6,
    plaque: 'Meet people. Ask to talk — mic by mutual permission. Entry with ticket.',
  },
  {
    // Backstage green room (4.5) — SPEAKERS ONLY. Behind the screen wall; no public plaque
    // (it's not a destination). accessKind null → not purchasable (money can't buy it).
    id: 'backstage', name: 'Backstage', emoji: '🎬', hue: 0xffb454,
    cx: BACKSTAGE_CENTER.x, cz: BACKSTAGE_CENTER.z, r: BACKSTAGE_CENTER.r,
    requires: 'backstageAccess', accessKind: null,
    private: true,               // no entrance plaque / occupancy sign
  },
  {
    // 🦩 Nostrich Park (4.10) — a PAID amusement park, far-right open land. Flamingo pink.
    // Entry 500 credits (Basic/Supporter) · included for Patron + speakers. Rides cost extra.
    id: 'park', name: 'Nostrich Park', emoji: '🦩', hue: 0xff5aa8,
    fx: PARK_GATE.x, fz: PARK_GATE.z,      // gate at the centre of the front arc (plaza-facing)
    cx: 25, cz: 14, r: 10.0,               // detection circle over the interior (station + pens)
    requires: 'parkAccess', accessKind: 'park',
    lettersText: 'NOSTRICH PARK', lettersH: 2.4,
    plaque: 'Entry 500 · rides extra. The Nostrich Coaster departs from the park station — 210 credits a seat.',
  },
];

// Per-zone arc geometry (radius + bearing from the stage), computed once.
const GEOM = {
  smoking:    { R: radiusOf(-13, 19), th: bearing(-13, 19) },
  networking: { R: radiusOf(6, 24),   th: bearing(6, 24) },
};

// ── Detection seam ──────────────────────────────────────────────────────────────────
const _subs = new Set();
let _current = null;
let _lastX = Infinity, _lastZ = Infinity;

function zoneAt(x, z) {
  for (const zn of ZONE_DEFS) {
    const dx = x - zn.cx, dz = z - zn.cz;
    if (dx * dx + dz * dz <= zn.r * zn.r) return zn;
  }
  return null;
}

// Zone-entry ACCESS gate — soft push to just outside a zone the player may not enter.
const EDGE = 0.15;
export function accessClamp(x, z, allow) {
  for (const zn of ZONE_DEFS) {
    const dx = x - zn.cx, dz = z - zn.cz;
    const d2 = dx * dx + dz * dz;
    if (d2 <= zn.r * zn.r && !allow(zn)) {
      const d = Math.sqrt(d2) || 1e-6;
      const k = (zn.r + EDGE) / d;
      return { x: zn.cx + dx * k, z: zn.cz + dz * k, blocked: zn };
    }
  }
  return { x, z, blocked: null };
}

// ── Park perimeter collision (4.17 #2) ─────────────────────────────────────────────────
// The park fence/arc is SOLID for players — entry/exit ONLY through the gate gap in the front arc.
// Building walls never had collision in the movement clamp (a general gap, not a park regression);
// this adds it for the park, resolving the wall side from the player's PREVIOUS (valid) position so a
// thin arc/fence can't be tunnelled at frame speed. Called from the frame-loop clamp chain.
const PB = 0.32;                                   // body radius (matches room/zones BODY_RADIUS)
const parkBearing = (x, z) => Math.atan2(x - C.x, z - C.z);
const parkRadius = (x, z) => Math.hypot(x - C.x, z - C.z);
const inParkSpan = (th) => th > PARK.th0 && th < PARK.th1;
const inParkGate = (th) => Math.abs(shortAng(th - PARK_TH)) < PARK.gateHalfAng;
export function parkClamp(px, pz, x, z) {
  const thNew = parkBearing(x, z), thPrev = parkBearing(px, pz);
  if (!inParkSpan(thNew) && !inParkSpan(thPrev)) return { x, z, hit: false }; // nowhere near the sector
  const rNew = parkRadius(x, z), rPrev = parkRadius(px, pz);
  // FRONT ARC (radius Ri) — the plaza-facing barrier. Crossing it is allowed only at the gate gap.
  if (inParkSpan(thNew) && (rPrev < PARK.Ri) !== (rNew < PARK.Ri) && !inParkGate(thNew)) {
    const target = (rPrev < PARK.Ri ? PARK.Ri - PB : PARK.Ri + PB) / (rNew || 1e-6);
    return { x: C.x + (x - C.x) * target, z: C.z + (z - C.z) * target, hit: true };
  }
  // RADIAL SIDE fences (th0, th1) — only within the fenced radius band. Keep the player on their side.
  if (rNew >= PARK.Ri - PB && rNew <= PARK.Ro) {
    for (const w of [PARK.th0, PARK.th1]) {
      if ((thPrev < w) !== (thNew < w) && Math.abs(shortAng(thNew - w)) < 0.35) {
        const th = thPrev < w ? w - 0.004 : w + 0.004;
        return { x: C.x + rNew * Math.sin(th), z: C.z + rNew * Math.cos(th), hit: true };
      }
    }
  }
  return { x, z, hit: false };
}

// ── Occupancy (mock population + the local player when inside) ─────────────────────────
// Deterministic seeded population per zone, so the badge mixes render as social proof. Real
// counts arrive when presence broadcasts each occupant's zone id (seam noted at top).
const MOCK_POP = {
  networking: { count: 11, patron: 3, supporter: 4, speaker: 1 },
  smoking:    { count: 6,  patron: 1, supporter: 2, speaker: 2 },
  backstage:  { count: 1,  patron: 0, supporter: 0, speaker: 1 }, // a co-panelist waiting
  park:       { count: 9,  patron: 4, supporter: 3, speaker: 0 }, // a busy amusement park
};
let _localBadge = { badge: null, speaker: false }; // the local player's marks (set by main)
let _liveCounts = {};                               // real live remote occupants per zone (4.4)
const _plaqueRedraws = [];                          // in-world occupancy displays to refresh

function occupancyOf(zoneId) {
  const base = MOCK_POP[zoneId] || { count: 0, patron: 0, supporter: 0, speaker: 0 };
  const here = _current && _current.id === zoneId; // local player counts only in THIS zone
  const b = _localBadge;
  return {
    // Real live remote participants (presence heartbeat zone) + local player + seeded mock.
    count:     base.count + (_liveCounts[zoneId] || 0) + (here ? 1 : 0),
    patron:    base.patron + (here && b.badge === 'patron' ? 1 : 0),
    supporter: base.supporter + (here && b.badge === 'supporter' ? 1 : 0),
    speaker:   base.speaker + (here && b.speaker ? 1 : 0),
  };
}

export const zones = {
  current() { return _current; },
  onChange(cb) { _subs.add(cb); return () => _subs.delete(cb); },
  occupancy(zoneId) { return occupancyOf(zoneId); },
  setLocalBadge(badge, speaker) { _localBadge = { badge: badge || null, speaker: !!speaker }; },
  // Feed live remote occupancy (from presence.zoneCounts()); re-textures plaques only when a
  // count actually changes, so this can be called every frame cheaply.
  setLiveOccupancy(counts) {
    const next = counts || {};
    let changed = false;
    for (const id of new Set([...Object.keys(next), ...Object.keys(_liveCounts)])) {
      if ((next[id] || 0) !== (_liveCounts[id] || 0)) { changed = true; break; }
    }
    if (!changed) return;
    _liveCounts = { ...next };
    for (const fn of _plaqueRedraws) fn();
  },
  refreshOccupancy() { for (const fn of _plaqueRedraws) fn(); }, // re-texture in-world counters
  update(x, z) {
    if (x === _lastX && z === _lastZ) return _current;
    _lastX = x; _lastZ = z;
    const next = zoneAt(x, z);
    if (next !== _current) {
      _current = next;
      for (const fn of _plaqueRedraws) fn();   // local player joined/left → counters change
      for (const cb of _subs) cb(_current);
    }
    return _current;
  },
};

// ── Decoration seam ─────────────────────────────────────────────────────────────────
//   zoneAnchors.networking = { walls:[back,left,right], floor, ceiling, propSpawns:[Object3D…] }
//   zoneAnchors.smoking    = { ground, perimeter:[back,left,right,frontL,frontR], propSpawns:[…] }
// walls/ground are also the future SPONSOR-screen mounts — kept clear.
export const zoneAnchors = { networking: null, smoking: null, backstage: null, park: null };

// ── Shared materials ──────────────────────────────────────────────────────────────────
const M = {
  wall:     new THREE.MeshBasicMaterial({ color: 0x0b111c, side: THREE.DoubleSide }),
  interior: new THREE.MeshBasicMaterial({ color: 0x0a0e16, side: THREE.DoubleSide }),
  floorNet: new THREE.MeshBasicMaterial({ color: 0x0a1218, side: THREE.DoubleSide }),
  hedge:    new THREE.MeshBasicMaterial({ color: 0x0a1108, side: THREE.DoubleSide }),
  groundSmk:new THREE.MeshBasicMaterial({ color: 0x100b07, side: THREE.DoubleSide }),
  post:     new THREE.MeshBasicMaterial({ color: 0x11151f }),
  teal:     new THREE.MeshBasicMaterial({ color: TEAL, transparent: true, opacity: 0.9 }),
  ember:    new THREE.MeshBasicMaterial({ color: EMBER, transparent: true, opacity: 0.9 }),
  gold:     new THREE.MeshBasicMaterial({ color: 0xffb454, transparent: true, opacity: 0.9 }),
  canopy:   new THREE.MeshBasicMaterial({ color: 0xffffff }), // tinted per-instance (instanceColor)
  trunk:    new THREE.MeshBasicMaterial({ color: 0x0a0806 }),
};

const plane = (w, h, mat) => new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
const hedge = (w, h) => new THREE.Mesh(new THREE.PlaneGeometry(w, h), M.hedge);
function radialGroup(radius, a) {
  const g = new THREE.Group();
  g.position.copy(onArc(radius, a));
  g.rotation.y = a;
  return g;
}
function addAnchor(group, x, z, name) {
  const o = new THREE.Object3D();
  o.position.set(x, 0, z);
  o.name = name;
  group.add(o);
  return o;
}

// ── Scenery ─────────────────────────────────────────────────────────────────────────
export function buildZoneScenery(scene) {
  const group = new THREE.Group();
  group.name = 'zoneScenery';
  const net = buildNetworking(ZONE_DEFS[1]);
  const smk = buildSmoking(ZONE_DEFS[0]);
  const bs = buildBackstage();
  const park = buildPark(ZONE_DEFS[3]);
  group.add(net.group, smk.group, bs.group, park.group);
  group.add(buildForest());              // night forest backdrop OUTSIDE both zones
  zoneAnchors.networking = net.anchors;
  zoneAnchors.smoking = smk.anchors;
  zoneAnchors.backstage = bs.anchors;
  zoneAnchors.park = park.anchors;
  scene.add(group);
  for (const fn of _plaqueRedraws) fn(); // initial occupancy draw
  return group;
}

// NETWORKING — grand enclosed hall.
function buildNetworking(zn) {
  const g = new THREE.Group();
  const R = radiusOf(zn.fx, zn.fz);
  const th = bearing(zn.fx, zn.fz);
  const H = NET_H, wallHalf = NET_WALLHALF, doorHalf = NET_DOORHALF, D = NET_DEPTH;
  const HW = R * Math.sin(wallHalf) + 0.05; // interior half-width ≈ facade half-chord

  g.add(arcWall(R, H, th - wallHalf, wallHalf - doorHalf, M.wall));
  g.add(arcWall(R, H, th + doorHalf, wallHalf - doorHalf, M.wall));
  g.add(arcWall(R + 0.02, 0.26, th - wallHalf, wallHalf * 2, M.teal, { y: H - 0.13 }));
  for (const s of [-1, 1]) {
    const jamb = new THREE.Mesh(new THREE.BoxGeometry(0.14, H, 0.14), M.teal);
    jamb.position.copy(onArc(R, th + s * doorHalf)); jamb.position.y = H / 2; jamb.rotation.y = th + s * doorHalf;
    g.add(jamb);
  }

  // Enclosure — clean dark texture-ready planes (front edge tucks behind the bowed facade ends).
  const room = radialGroup(R, th);
  const zc = (D - 1) / 2;
  const floor = plane(2 * HW, D + 1, M.floorNet);   floor.rotation.x = -Math.PI / 2; floor.position.set(0, 0.02, zc);
  const ceiling = plane(2 * HW, D + 1, M.interior); ceiling.rotation.x = Math.PI / 2; ceiling.position.set(0, H, zc);
  const back = plane(2 * HW, H, M.interior);        back.position.set(0, H / 2, D);
  const left = plane(D + 1, H, M.interior);         left.rotation.y = Math.PI / 2;  left.position.set(-HW, H / 2, zc);
  const right = plane(D + 1, H, M.interior);        right.rotation.y = -Math.PI / 2; right.position.set(HW, H / 2, zc);
  room.add(floor, ceiling, back, left, right);
  // Prop anchors respawned across the bigger hall.
  const propSpawns = [
    addAnchor(room, 0, 6, 'net-centre'),
    addAnchor(room, -6, 8, 'net-sofa-L'),
    addAnchor(room, 6, 8, 'net-sofa-R'),
    addAnchor(room, -6.5, 15, 'net-lounge-L'),
    addAnchor(room, 6.5, 15, 'net-lounge-R'),
    addAnchor(room, 0, 19, 'net-back'),
  ];
  g.add(room);

  g.add(placeLetters(zn, R + 0.1, th, H + 1.3));
  g.add(placePlaque(zn, R, th + wallHalf + 0.06));

  return { group: g, anchors: { walls: [back, left, right], floor, ceiling, propSpawns } };
}

// SMOKING — park gate + enclosed clearing (forest is built globally, not here).
function buildSmoking(zn) {
  const g = new THREE.Group();
  const R = radiusOf(zn.fx, zn.fz);
  const th = bearing(zn.fx, zn.fz);
  const postH = SMK_POSTH, gateHalf = SMK_GATEHALF;
  const CW = SMK_CW, CD = SMK_CD, HH = SMK_HH;

  for (const s of [-1, 1]) {
    const a = th + s * gateHalf;
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.36, postH, 0.36), M.post);
    post.position.copy(onArc(R, a)); post.position.y = postH / 2; post.rotation.y = a; g.add(post);
    const cap = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.12, 0.5), M.ember);
    cap.position.copy(onArc(R, a)); cap.position.y = postH; cap.rotation.y = a; g.add(cap);
  }
  const beamG = radialGroup(R, th);
  const beamW = 2 * gateHalf * R + 0.8;
  const beam = new THREE.Mesh(new THREE.BoxGeometry(beamW, 0.34, 0.3), M.post); beam.position.y = postH + 0.05; beamG.add(beam);
  const frame = new THREE.Mesh(new THREE.BoxGeometry(beamW, 0.08, 0.34), M.ember); frame.position.y = postH + 0.24; beamG.add(frame);
  g.add(beamG);

  const yard = radialGroup(R, th);
  const gapHalf = R * Math.sin(gateHalf) + 0.2;
  const zc = CD / 2;
  const ground = plane(CW, CD, M.groundSmk); ground.rotation.x = -Math.PI / 2; ground.position.set(0, 0.02, zc);
  const back = hedge(CW, HH); back.position.set(0, HH / 2, CD);
  const leftH = hedge(CD, HH); leftH.rotation.y = Math.PI / 2; leftH.position.set(-CW / 2, HH / 2, zc);
  const rightH = hedge(CD, HH); rightH.rotation.y = -Math.PI / 2; rightH.position.set(CW / 2, HH / 2, zc);
  const frontW = CW / 2 - gapHalf;
  const frontL = hedge(frontW, HH); frontL.position.set(-(gapHalf + frontW / 2), HH / 2, 0);
  const frontR = hedge(frontW, HH); frontR.position.set(gapHalf + frontW / 2, HH / 2, 0);
  yard.add(ground, back, leftH, rightH, frontL, frontR);
  const propSpawns = [
    addAnchor(yard, 0, 8, 'smk-cigar-bar'),
    addAnchor(yard, -3, 4.5, 'smk-bench-L'),
    addAnchor(yard, 3, 4.5, 'smk-bench-R'),
    addAnchor(yard, 0, 5, 'smk-heater'),
  ];
  g.add(yard);

  g.add(placeLetters(zn, R + 0.05, th, postH + 1.15));
  g.add(placePlaque(zn, R, th + gateHalf + 0.12));

  return { group: g, anchors: { ground, perimeter: [back, leftH, rightH, frontL, frontR], propSpawns } };
}

// BACKSTAGE — an enclosed green room behind the screen wall; door on the stage-LEFT (−x)
// wall aligned to the approach lane. Solid walls + ceiling → the interior never leaks to the
// plaza (3.13c enclosure). Speakers only; texture-ready planes + couch/table prop anchors.
function buildBackstage() {
  const g = new THREE.Group();
  const { cx, cz, w, h, d, doorHalf } = BACKSTAGE;
  const x0 = cx - w / 2, x1 = cx + w / 2, z0 = cz - d / 2, z1 = cz + d / 2;

  const floor = plane(w, d, M.floorNet); floor.rotation.x = -Math.PI / 2; floor.position.set(cx, 0.02, cz);
  const ceil  = plane(w, d, M.interior); ceil.rotation.x = Math.PI / 2;  ceil.position.set(cx, h, cz);
  const back  = plane(w, h, M.wall);     back.position.set(cx, h / 2, z0);
  const front = plane(w, h, M.wall);     front.position.set(cx, h / 2, z1);          // faces the screen wall
  const right = plane(d, h, M.wall);     right.rotation.y = -Math.PI / 2; right.position.set(x1, h / 2, cz);
  // −x wall (stage-left) split around the doorway (aligned to the lane at cz).
  const segD = (d - 2 * doorHalf) / 2;
  const leftA = plane(segD, h, M.wall);  leftA.rotation.y = Math.PI / 2; leftA.position.set(x0, h / 2, z0 + segD / 2);
  const leftB = plane(segD, h, M.wall);  leftB.rotation.y = Math.PI / 2; leftB.position.set(x0, h / 2, z1 - segD / 2);
  g.add(floor, ceil, back, front, right, leftA, leftB);

  for (const s of [-1, 1]) {                                   // door jambs
    const jamb = new THREE.Mesh(new THREE.BoxGeometry(0.12, h, 0.12), M.gold);
    jamb.position.set(x0, h / 2, cz + s * doorHalf); g.add(jamb);
  }
  const sign = makeLettersPlane('BACKSTAGE', 0xffb454, 0.34);  // subtle, not a landmark
  sign.position.set(x0 - 0.05, h - 0.5, cz); sign.rotation.y = -Math.PI / 2; g.add(sign);

  const propSpawns = [
    addAnchor(g, cx, cz + 1.0, 'bs-couch'),
    addAnchor(g, cx - 2.5, cz, 'bs-chair-L'),
    addAnchor(g, cx + 2.5, cz, 'bs-chair-R'),
    addAnchor(g, cx, cz - 1.5, 'bs-table'),
  ];
  return { group: g, anchors: { walls: [back, front, right, leftA, leftB], floor, ceiling: ceil, propSpawns } };
}

// 🦩 NOSTRICH PARK — a large open-air fenced park; the entrance GLB is the sole gate (async-loaded,
// scaled to fit; primitive gateposts stand in until it lands). Fence perimeter closes the rest.
// The flock + coaster are added by main (they animate). Ground + fence are texture-ready anchors.
function buildPark(zn) {
  const g = new THREE.Group();
  const { cx, cz, Ri, Ro, h, gateHalfAng } = PARK;
  const thc = PARK_TH;

  // Ground = a ring-SECTOR concentric with the venue (matches the arc facade; RingGeometry angle
  // α = bearing − π/2 to map into our stage-relative bearing convention).
  const ground = new THREE.Mesh(new THREE.RingGeometry(Ri, Ro, 56, 1, PARK.th0 - Math.PI / 2, PARK.th1 - PARK.th0), M.groundSmk);
  ground.rotation.x = -Math.PI / 2; ground.position.set(C.x, 0.02, C.z); g.add(ground);

  // Front barrier = an ARC concentric with the venue circles (like Networking's facade), split
  // around a central GATE gap. A matching arc closes the back; radial fences close the two sides.
  const frontL = arcWall(Ri, h, PARK.th0, (thc - gateHalfAng) - PARK.th0, M.hedge);
  const frontR = arcWall(Ri, h, thc + gateHalfAng, PARK.th1 - (thc + gateHalfAng), M.hedge);
  const back = arcWall(Ro, h, PARK.th0, PARK.th1 - PARK.th0, M.hedge);
  g.add(frontL, frontR, back);
  const sides = [];
  for (const th of [PARK.th0, PARK.th1]) {                        // radial side fences (Ri→Ro)
    const side = hedge(Ro - Ri, h);
    side.position.copy(onArc((Ri + Ro) / 2, th)); side.position.y = h / 2; side.rotation.y = th - Math.PI / 2;
    g.add(side); sides.push(side);
  }
  // No primitive gateposts (4.17 #1) — the entrance GLB (the two guardian-bird sculptures) IS the
  // gate and stands alone in the front-arc gap. The name letters sit ABOVE the tall GLB.
  const propSpawns = [addAnchor(g, cx, cz, 'park-centre'), addAnchor(g, cx - 6, cz + 6, 'park-snack'), addAnchor(g, cx + 6, cz - 6, 'park-photo')];

  const GATE_H = (h + 1.4) * 2;                        // GLB fit height (~8.8 m)
  g.add(placeLetters(zn, Ri + 0.1, thc, GATE_H + 0.9)); // letters clear ABOVE the gate GLB
  g.add(placePlaque(zn, Ri, thc + PARK.gateHalfAng + 0.10)); // plaque just beside the gate gap

  // Entrance GLB — the sole gate (scaled ×2), seated on the ground in the front-arc gap, facing the
  // plaza. Graceful absence: the fence gap just stays open.
  loadGLB('nostriches_entrance.glb').then((gate) => {
    if (!gate) { console.warn('[park] entrance GLB absent — open gateway'); return; }
    const scale = fitToHeight(gate, GATE_H);
    const box = measure(gate).box;
    const at = onArc(Ri, thc);
    gate.position.set(at.x, -box.min.y, at.z);
    gate.rotation.y = thc + Math.PI;                  // face inward (toward the plaza / stage centre)
    g.add(gate);
    console.log('[park] entrance GLB placed · fit scale', scale.toFixed(3), '(×2)');
  });

  return { group: g, anchors: { ground, fence: [frontL, frontR, back, ...sides], propSpawns } };
}

// A curved wall arc = an open-ended cylinder segment centred on the stage.
function arcWall(radius, height, thetaStart, thetaLength, mat, opt = {}) {
  const segs = Math.max(6, Math.round((thetaLength / (Math.PI * 2)) * 240));
  const geo = new THREE.CylinderGeometry(radius, radius, height, segs, 1, true, thetaStart, thetaLength);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(C.x, opt.y ?? height / 2, C.z);
  return mesh;
}

// ── Night forest ──────────────────────────────────────────────────────────────────────
// Two InstancedMeshes (trunks + canopies) of a stylized 3-tier conifer. Deterministic scatter
// across the back hemisphere with EXCLUSION regions so trees only ever sit OUTSIDE the zone
// interiors / building footprints, clear of the door approaches and the central plaza walkway.
function buildForest() {
  const g = new THREE.Group();
  g.name = 'forest';
  const items = scatterTrees();
  const N = items.length;
  const canopy = new THREE.InstancedMesh(makeConifer(), M.canopy, N);
  const trunk = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.12, 0.17, 1.0, 6).translate(0, 0.5, 0), M.trunk, N);
  canopy.frustumCulled = false; trunk.frustumCulled = false;
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0), col = new THREE.Color();
  items.forEach((it, i) => {
    q.setFromAxisAngle(up, it.rot);
    p.set(it.x, 0, it.z); s.set(it.sc, it.sc * it.hv, it.sc);
    m.compose(p, q, s);
    canopy.setMatrixAt(i, m); trunk.setMatrixAt(i, m);
    canopy.setColorAt(i, col.copy(it.tint));
  });
  canopy.instanceMatrix.needsUpdate = true; trunk.instanceMatrix.needsUpdate = true;
  if (canopy.instanceColor) canopy.instanceColor.needsUpdate = true;
  g.add(trunk, canopy);
  return g;
}

// A stylized conifer canopy: 3 slightly-irregular stacked cone tiers merged into ONE geometry
// (base sitting on the trunk top). Silhouette shape; per-instance tint/scale/rotation vary it.
function makeConifer() {
  const tiers = [
    { r: 0.95, h: 1.35, y: 1.15, rot: 0.0 },
    { r: 0.70, h: 1.15, y: 1.95, rot: 0.5 },
    { r: 0.46, h: 1.05, y: 2.65, rot: 1.0 },
  ];
  const parts = tiers.map((t, k) => {
    const c = new THREE.ConeGeometry(t.r, t.h, 6);
    c.rotateY(t.rot);
    c.translate((k === 1 ? 0.07 : -0.05), t.y, (k === 2 ? 0.06 : 0.0)); // slight irregular stacking
    return c;
  });
  return mergeGeos(parts);
}

// Minimal geometry merge (position only — MeshBasic needs no normals). Avoids an addon import.
function mergeGeos(geos) {
  const arrs = geos.map((g) => (g.index ? g.toNonIndexed() : g).attributes.position.array);
  let n = 0; for (const a of arrs) n += a.length;
  const pos = new Float32Array(n);
  let o = 0; for (const a of arrs) { pos.set(a, o); o += a.length; }
  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  return merged;
}

// Deterministic exclusion scatter. Returns [{x,z,sc,hv,rot,tint}].
function scatterTrees() {
  const out = [];
  const cool = new THREE.Color(0x0e1a14), ember = new THREE.Color(0x241309);
  const hash = (i) => { const x = Math.sin(i * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
  const NET = GEOM.networking, SMK = GEOM.smoking;
  const netHalfAng = NET_WALLHALF;                          // hall angular half-width
  const smkHalfAng = Math.asin((SMK_CW / 2) / SMK.R);       // clearing angular half-width
  let i = 0;
  for (let ang = -1.15; ang <= 1.15 + 1e-6; ang += 0.085) {
    for (let rr = 33; rr <= 54; rr += 2.3) {
      const h1 = hash(i * 3 + 1), h2 = hash(i * 3 + 2), h3 = hash(i * 3 + 3); i++;
      const a = ang + (h1 - 0.5) * 0.06;
      const rad = rr + (h2 - 0.5) * 1.7;
      if (rad < 32) continue;
      const dNet = Math.abs(shortAng(a - NET.th)), dSmk = Math.abs(shortAng(a - SMK.th));
      // EXCLUDE: building footprints (+margin), door-approach corridors, central plaza walkway.
      if (rad > NET.R - 1.5 && rad < NET.R + NET_DEPTH + 2 && dNet < netHalfAng + 0.13) continue;
      if (rad > SMK.R - 1.5 && rad < SMK.R + SMK_CD + 2 && dSmk < smkHalfAng + 0.13) continue;
      if (dNet < 0.13 && rad < NET.R + 1) continue;         // networking approach
      if (dSmk < 0.13 && rad < SMK.R + 1) continue;         // smoking approach
      if (rad < 40 && Math.abs(a) < 0.5) continue;          // central plaza / audience corridor
      const pos = onArc(rad, a);
      const prox = Math.max(0, 1 - dSmk / 0.55);            // ember rim near Smoking
      const tint = cool.clone().lerp(ember, prox).multiplyScalar(0.72 + h3 * 0.55);
      out.push({ x: pos.x, z: pos.z, sc: 0.85 + h1 * 0.9, hv: 0.9 + h2 * 0.55, rot: h3 * Math.PI * 2, tint });
    }
  }
  return out;
}

// ── Letters + plaque (canvas textures) ────────────────────────────────────────────────
function placeLetters(zn, radius, a, y) {
  const g = radialGroup(radius, a);
  const mesh = makeLettersPlane(zn.lettersText, zn.hue, zn.lettersH);
  mesh.position.y = y; mesh.rotation.y = Math.PI;
  g.add(mesh);
  return g;
}

function makeLettersPlane(text, color, worldH) {
  const pad = 40, fontPx = 150;
  const cv = document.createElement('canvas');
  let g = cv.getContext('2d');
  g.font = `800 ${fontPx}px ui-monospace, "SF Mono", Menlo, monospace`;
  const w = Math.ceil(g.measureText(text).width) + pad * 2;
  const h = fontPx + pad * 2;
  cv.width = w; cv.height = h;
  g = cv.getContext('2d');
  g.font = `800 ${fontPx}px ui-monospace, "SF Mono", Menlo, monospace`;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  const hex = `#${new THREE.Color(color).getHexString()}`;
  g.shadowColor = hex; g.shadowBlur = 46; g.fillStyle = hex;
  g.fillText(text, w / 2, h / 2);
  g.shadowBlur = 0; g.fillStyle = '#fff6ec'; g.globalAlpha = 0.9;
  g.fillText(text, w / 2, h / 2); g.globalAlpha = 1;
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry((w / h) * worldH, worldH),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }),
  );
  mesh.renderOrder = 3;
  return mesh;
}

// Plaque = a stand + a SOLID panel carrying the zone name, copy, and a live OCCUPANCY line
// (re-textured on change only). Its redraw is registered so zones.update can refresh it.
function placePlaque(zn, radius, a) {
  const g = radialGroup(radius, a);
  const postH = 1.02, panelW = 1.6, panelH = 1.12;
  const post = new THREE.Mesh(new THREE.BoxGeometry(0.09, postH, 0.09), M.post);
  post.position.y = postH / 2; g.add(post);
  const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.3, 0.06, 20), M.post);
  foot.position.y = 0.03; g.add(foot);
  const { mesh, redraw } = makePlaquePanel(zn, panelW, panelH);
  mesh.position.set(0, postH + panelH / 2 - 0.04, 0);
  mesh.rotation.y = Math.PI; mesh.rotateX(0.16);
  g.add(mesh);
  _plaqueRedraws.push(() => redraw(occupancyOf(zn.id)));
  return g;
}

const MONO = 'ui-monospace, "SF Mono", Menlo, monospace';
function occLine(occ) {
  if (!occ.count) return '👥 quiet in here';
  const b = [occ.patron && `◆${occ.patron}`, occ.supporter && `◇${occ.supporter}`, occ.speaker && `🎙${occ.speaker}`].filter(Boolean).join('  ');
  return `👥 ${occ.count} inside${b ? `  ·  ${b}` : ''}`;
}
function makePlaquePanel(zn, worldW, worldH) {
  const CW = 640, CH = Math.round(CW * (worldH / worldW));
  const cv = document.createElement('canvas'); cv.width = CW; cv.height = CH;
  const ctx = cv.getContext('2d');
  const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(worldW, worldH), new THREE.MeshBasicMaterial({ map: tex }));
  const hex = `#${new THREE.Color(zn.hue).getHexString()}`;
  function redraw(occ) {
    ctx.clearRect(0, 0, CW, CH);
    roundRect(ctx, 3, 3, CW - 6, CH - 6, 20);
    ctx.fillStyle = '#0c111b'; ctx.fill();
    ctx.strokeStyle = hex; ctx.lineWidth = 3; ctx.globalAlpha = 0.8; ctx.stroke(); ctx.globalAlpha = 1;
    ctx.textBaseline = 'alphabetic'; ctx.fillStyle = hex;
    ctx.font = `700 38px ${MONO}`;
    ctx.fillText(`${zn.emoji} ${zn.name}`, 30, 58);
    ctx.fillStyle = 'rgba(236,238,245,0.9)'; ctx.font = '400 27px system-ui, -apple-system, sans-serif';
    wrapText(ctx, zn.plaque, 30, 100, CW - 60, 34);
    ctx.strokeStyle = 'rgba(255,255,255,0.10)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(30, CH - 52); ctx.lineTo(CW - 30, CH - 52); ctx.stroke();
    ctx.fillStyle = hex; ctx.font = `700 27px ${MONO}`;
    ctx.fillText(occLine(occ), 30, CH - 22); // live occupancy — social proof before entering
    tex.needsUpdate = true;
  }
  return { mesh, redraw };
}

function wrapText(ctx, text, x, y, maxW, lh) {
  let line = '', yy = y;
  for (const word of String(text).split(/\s+/)) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxW && line) { ctx.fillText(line, x, yy); line = word; yy += lh; }
    else line = test;
  }
  if (line) ctx.fillText(line, x, yy);
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r);
  g.closePath();
}
