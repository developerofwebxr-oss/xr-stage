import * as THREE from 'three';

// room/flock.js — the Nostrich Park flock (4.10), placeholder v1 from cheap primitives.
//
// NODE-NAME SPEC (the seam the owner's future Spline ostrich GLB swaps into — keep these names):
//   ostrich(root) → body · neck_lower · neck_upper · head · leg_L · leg_R · wing_L · wing_R · tail
//   Joint pivots: neck_lower at the shoulders, neck_upper atop neck_lower, head atop neck_upper,
//   legs at the hips, wings at the shoulders, tail at the rear. To swap: load the GLB, ensure the
//   same named nodes exist, and this same FK driver animates it unchanged.
//
// Animation = procedural FK "personalities": amble walk-cycle (alternating legs + body bob), neck
// sway + peck, occasional wing-flap, and ONE "buggy" bird that sprints/spins. Deterministic per
// bird (hashed index) → same show every load. Wander stays inside a PEN rect (never walks through
// guests — guests are outside the pens). SHARED geometries/materials; ~9 primitive meshes/bird.
// prefers-reduced-motion → static idle poses, no motion.
//
//   createFlock(scene, { center:{x,z}, pens:[{x,z,w,d}], count }) → { update(dt) }

const REDUCE = matchMedia('(prefers-reduced-motion: reduce)').matches;
const PINK = 0xff5aa8, PINK_DK = 0xd23f86, LEG = 0x3a2a30, BEAK = 0xff9a3c;

// 🦩 Feed-the-Nostriches (4.14). Each bird has a FIXED personality (deterministic from its id) that
// plays as a short FK reaction when fed. Order is the seed order — index = floor(hash·6).
const REACTIONS = ['screamer', 'biter', 'kisser', 'ostrich', 'sprinter', 'diva'];
// Deterministic personality per bird id: a scrambled permutation of all six so every reaction is
// discoverable across the flock (not an obvious 0..5 run), yet each bird always reacts the same.
const SEED_ORDER = [2, 4, 0, 5, 1, 3];
const REACT_DUR = { screamer: 2.4, biter: 2.0, kisser: 2.0, ostrich: 2.6, sprinter: 3.0, diva: 2.5 };
const FEED_COOLDOWN = 10;   // seconds between feeds of the same bird (so a reaction can finish)
const easeInOut = (k) => (k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2);
const bump = (k) => Math.sin(Math.PI * Math.min(1, Math.max(0, k)));   // 0→1→0 envelope

// Shared geometry (one of each, reused across every bird → cheap).
const G = {
  body: new THREE.SphereGeometry(0.5, 12, 10),
  neck: new THREE.CylinderGeometry(0.08, 0.11, 0.6, 7),
  head: new THREE.SphereGeometry(0.14, 10, 8),
  beak: new THREE.ConeGeometry(0.06, 0.22, 7),
  leg:  new THREE.CylinderGeometry(0.045, 0.05, 0.9, 6),
  wing: new THREE.SphereGeometry(0.3, 8, 6),
  tail: new THREE.ConeGeometry(0.22, 0.5, 8),
};
const M = {
  pink: new THREE.MeshStandardMaterial({ color: PINK, roughness: 0.8 }),
  pinkDk: new THREE.MeshStandardMaterial({ color: PINK_DK, roughness: 0.8 }),
  leg: new THREE.MeshStandardMaterial({ color: LEG, roughness: 0.9 }),
  beak: new THREE.MeshStandardMaterial({ color: BEAK, roughness: 0.6 }),
};
const part = (geo, mat, name) => { const m = new THREE.Mesh(geo, mat); m.name = name; return m; };

// One ostrich with the named-part hierarchy + joint pivots. ~1.7 m tall standing.
function makeOstrich() {
  const root = new THREE.Group(); root.name = 'ostrich';

  const body = part(G.body, M.pink, 'body');
  body.scale.set(1.1, 0.85, 1.4); body.position.y = 1.0; root.add(body);

  const tail = part(G.tail, M.pinkDk, 'tail');
  tail.position.set(0, 1.05, 0.62); tail.rotation.x = Math.PI / 2.1; root.add(tail);

  // Neck chain: pivots at the base of each segment so rotations read as bends.
  const neckLower = new THREE.Group(); neckLower.name = 'neck_lower'; neckLower.position.set(0, 1.3, -0.5);
  const nlMesh = part(G.neck, M.pink, 'neck_lower_mesh'); nlMesh.position.y = 0.3; neckLower.add(nlMesh);
  const neckUpper = new THREE.Group(); neckUpper.name = 'neck_upper'; neckUpper.position.y = 0.6;
  const nuMesh = part(G.neck, M.pink, 'neck_upper_mesh'); nuMesh.scale.set(0.85, 0.8, 0.85); nuMesh.position.y = 0.24; neckUpper.add(nuMesh);
  const head = new THREE.Group(); head.name = 'head'; head.position.y = 0.5;
  const headMesh = part(G.head, M.pink, 'head_mesh'); head.add(headMesh);
  const beak = part(G.beak, M.beak, 'beak'); beak.position.set(0, 0, -0.16); beak.rotation.x = -Math.PI / 2; head.add(beak);
  neckUpper.add(head); neckLower.add(neckUpper); root.add(neckLower);

  for (const s of [-1, 1]) {
    const leg = new THREE.Group(); leg.name = s < 0 ? 'leg_L' : 'leg_R'; leg.position.set(s * 0.18, 0.9, 0.05);
    const lMesh = part(G.leg, M.leg, `${leg.name}_mesh`); lMesh.position.y = -0.45; leg.add(lMesh);
    root.add(leg);
    const wing = new THREE.Group(); wing.name = s < 0 ? 'wing_L' : 'wing_R'; wing.position.set(s * 0.45, 1.05, 0.05);
    const wMesh = part(G.wing, M.pinkDk, `${wing.name}_mesh`); wMesh.scale.set(0.5, 0.9, 1.3); wing.add(wMesh);
    root.add(wing);
  }
  return root;
}

const hash = (i, s) => { const x = Math.sin(i * 12.9898 + s * 78.233) * 43758.5453; return x - Math.floor(x); };
const inPen = (p, x, z) => x > p.x - p.w / 2 + 0.4 && x < p.x + p.w / 2 - 0.4 && z > p.z - p.d / 2 + 0.4 && z < p.z + p.d / 2 - 0.4;

export function createFlock(scene, { center = { x: 0, z: 0 }, pens = [], count = 8 } = {}) {
  const group = new THREE.Group(); group.name = 'flock';
  scene.add(group);
  const penList = pens.length ? pens : [{ x: center.x, z: center.z, w: 10, d: 10 }];
  const birds = [];
  const byId = new Map();
  for (let i = 0; i < count; i++) {
    const pen = penList[i % penList.length];
    const o = makeOstrich();
    const buggy = i === count - 1;                     // the one glitchy bird
    const id = `nostrich-${i}`;
    const b = {
      root: o, pen, id,
      reaction: REACTIONS[SEED_ORDER[i % REACTIONS.length]], // FIXED personality (4.14)
      react: null, lastFed: -100,
      x: pen.x + (hash(i, 1) - 0.5) * pen.w * 0.6,
      z: pen.z + (hash(i, 2) - 0.5) * pen.d * 0.6,
      heading: hash(i, 3) * Math.PI * 2,
      phase: hash(i, 4) * Math.PI * 2,                 // gait phase offset
      speed: 0.5 + hash(i, 5) * 0.5,
      peckAt: 2 + hash(i, 6) * 5,
      buggy, t: 0,
    };
    o.userData.birdId = id;                            // unified-select pick key (4.14)
    // The model's FRONT (beak/head cluster) is built toward −Z; wander steps along +Z
    // (sin/cos(heading)). Face the model's −Z down the travel direction → rotation = heading + π,
    // so the beak leads (not tail-first). See update() for the same offset each frame.
    o.position.set(b.x, 0, b.z); o.rotation.y = b.heading + Math.PI;
    group.add(o);
    birds.push(b); byId.set(id, b);
    // per-part refs (named lookups → also work after a GLB swap)
    b.parts = {
      body: o.getObjectByName('body'), neckL: o.getObjectByName('neck_lower'), neckU: o.getObjectByName('neck_upper'),
      head: o.getObjectByName('head'), legL: o.getObjectByName('leg_L'), legR: o.getObjectByName('leg_R'),
      wingL: o.getObjectByName('wing_L'), wingR: o.getObjectByName('wing_R'),
    };
  }

  function update(dt) {
    for (const b of birds) {
      b.t += dt;
      if (b.react) { playReaction(b, dt); continue; } // a reaction OWNS the bird (also under reduced motion)
      if (REDUCE) continue;                            // otherwise: static idle poses under reduced motion
      animateWander(b, dt);
    }
  }

  // Idle wander + gait + neck sway (the default life; extracted so reactions can pre-empt it).
  function animateWander(b, dt) {
    const p = b.parts;
    const spd = b.buggy ? 2.6 : b.speed;
    const nx = b.x + Math.sin(b.heading) * spd * dt, nz = b.z + Math.cos(b.heading) * spd * dt;
    if (inPen(b.pen, nx, nz)) { b.x = nx; b.z = nz; } else { b.heading += 1.6 + hash(Math.floor(b.t), 7); }
    if (b.buggy) b.heading += dt * 5.5; else b.heading += (hash(Math.floor(b.t * 0.7), 8) - 0.5) * dt * 1.2;
    b.root.position.set(b.x, 0, b.z);
    b.root.rotation.y = b.heading + Math.PI;   // face travel (model front is −Z) → beak leads

    const g = b.t * (b.buggy ? 16 : 7) + b.phase;
    if (p.legL) p.legL.rotation.x = Math.sin(g) * 0.5;
    if (p.legR) p.legR.rotation.x = Math.sin(g + Math.PI) * 0.5;
    if (p.body) p.body.position.y = 1.0 + Math.abs(Math.sin(g)) * 0.04;
    const peck = (b.t % (b.peckAt + 2)) > b.peckAt ? Math.sin(b.t * 9) * 0.5 + 0.5 : 0;
    if (p.neckL) p.neckL.rotation.x = -0.15 + Math.sin(b.t * 1.5 + b.phase) * 0.12 + peck * 0.9;
    if (p.neckU) p.neckU.rotation.x = 0.2 - peck * 0.7;
    if (p.head) p.head.rotation.x = peck * 0.6;
    const flap = b.buggy ? 0.9 : (Math.sin(b.t * 0.5 + b.phase) > 0.9 ? Math.sin(b.t * 22) * 0.6 + 0.6 : 0);
    if (p.wingL) p.wingL.rotation.z = flap * 0.8;
    if (p.wingR) p.wingR.rotation.z = -flap * 0.8;
  }

  // ── Feed reactions (4.14) ──────────────────────────────────────────────────────────
  // A short FK sequence keyed to the bird's FIXED personality, aimed at the feeder. Under reduced
  // motion every type collapses to a minimal head-dip. On finish the bird resumes its wander.
  function playReaction(b, dt) {
    const p = b.parts, r = b.react;
    r.t += dt;
    const k = Math.min(1, r.t / r.dur);
    if (r.reduced) {                                   // reduced motion: just a gentle head-dip
      if (p.neckL) p.neckL.rotation.x = -0.15 + bump(k) * 0.8;
      if (r.t >= r.dur) finishReaction(b);
      return;
    }
    switch (r.type) {
      case 'screamer': {                               // rear up + neck stretches at the feeder's face
        const e = k < 0.75 ? Math.min(1, k / 0.15) : 1 - (k - 0.75) / 0.25;
        b.root.rotation.set(0, r.faceYaw, 0);
        if (p.neckL) p.neckL.rotation.x = -0.15 - 1.05 * e;
        if (p.neckU) p.neckU.rotation.x = -0.55 * e;
        if (p.head)  p.head.rotation.x = -0.35 * e;
        if (p.body)  p.body.position.y = 1.0 + 0.16 * e;
        if (p.legL)  p.legL.rotation.x = -0.22 * e;
        if (p.legR)  p.legR.rotation.x = -0.22 * e;
        break;
      }
      case 'biter': {                                  // two quick forward snaps, then a head shake
        b.root.rotation.set(0, r.faceYaw, 0);
        const jab = k < 0.55 ? Math.abs(Math.sin(k * Math.PI * 4)) : 0;
        const shake = k >= 0.55 ? Math.sin((k - 0.55) * Math.PI * 10) * (1 - (k - 0.55) / 0.45) : 0;
        if (p.neckL) p.neckL.rotation.x = -0.1 + 1.0 * jab;
        if (p.head)  { p.head.rotation.x = 0.3 * jab; p.head.rotation.y = shake * 0.5; }
        break;
      }
      case 'kisser': {                                 // gentle head-boop toward the feeder
        b.root.rotation.set(0, r.faceYaw, 0);
        const e = bump(k);
        if (p.neckL) p.neckL.rotation.x = -0.15 - 0.55 * e;
        if (p.neckU) p.neckU.rotation.x = 0.2 - 0.3 * e;
        if (p.head)  p.head.rotation.x = -0.15 * e + Math.sin(k * Math.PI * 3) * 0.1 * e;
        break;
      }
      case 'ostrich': {                                // head plunges into the ground, tail up, wiggle
        const e = k < 0.7 ? easeInOut(Math.min(1, k / 0.3)) : 1 - (k - 0.7) / 0.3;
        const wig = Math.sin(k * Math.PI * 8) * 0.1 * e;
        b.root.rotation.set(-0.5 * e, r.faceYaw, wig);  // front(−Z) pitches down, tail rises
        if (p.neckL) p.neckL.rotation.x = 0.2 + 1.6 * e;
        if (p.neckU) p.neckU.rotation.x = 0.6 * e;
        break;
      }
      case 'sprinter': {                               // grab + a panicked lap, then ease home
        if (k < 0.8) {
          b.heading += dt * 4.2;
          const spd = 5.5;
          const nx = b.x + Math.sin(b.heading) * spd * dt, nz = b.z + Math.cos(b.heading) * spd * dt;
          if (inPen(b.pen, nx, nz)) { b.x = nx; b.z = nz; } else { b.heading += 2.2; }
        } else {                                        // return toward where it was fed
          const t = (k - 0.8) / 0.2;
          b.x += (r.home.x - b.x) * Math.min(1, t * 2);
          b.z += (r.home.z - b.z) * Math.min(1, t * 2);
        }
        b.root.position.set(b.x, 0, b.z);
        b.root.rotation.set(0, b.heading + Math.PI, 0);
        const g = b.t * 22 + b.phase;                   // fast leg pump
        if (p.legL) p.legL.rotation.x = Math.sin(g) * 0.7;
        if (p.legR) p.legR.rotation.x = Math.sin(g + Math.PI) * 0.7;
        break;
      }
      case 'diva': {                                   // turn away, ignore, one slow wing flick
        b.root.rotation.set(0, r.faceYaw + Math.PI, 0); // face AWAY from the feeder
        if (p.neckL) p.neckL.rotation.x = -0.1;
        const flick = bump(Math.min(1, Math.max(0, (k - 0.2) / 0.6)));
        if (p.wingR) p.wingR.rotation.z = -1.1 * flick;
        break;
      }
    }
    if (r.t >= r.dur) finishReaction(b);
  }

  function finishReaction(b) {
    const p = b.parts;
    b.root.rotation.set(0, b.heading + Math.PI, 0);     // clear any pitch/roll/away-yaw
    if (p.body) { p.body.position.y = 1.0; p.body.rotation.set(0, 0, 0); }
    if (p.head) p.head.rotation.set(0, 0, 0);
    if (p.neckL) p.neckL.rotation.set(0, 0, 0);
    if (p.neckU) p.neckU.rotation.set(0, 0, 0);
    if (p.wingL) p.wingL.rotation.set(0, 0, 0);
    if (p.wingR) p.wingR.rotation.set(0, 0, 0);
    b.lastFed = b.t; b.react = null;
  }

  const _wp = new THREE.Vector3();
  return {
    group, update,
    pickTargets: () => birds.map((b) => b.root),                       // unified-select raycast targets
    reactionOf: (id) => byId.get(id)?.reaction || null,
    reactionMap: () => birds.map((b) => ({ id: b.id, reaction: b.reaction })), // the seed map (report)
    canFeed: (id) => { const b = byId.get(id); return !!b && !b.react && b.t - b.lastFed >= FEED_COOLDOWN; },
    headWorldPos: (id, out = new THREE.Vector3()) => { const b = byId.get(id); return b ? b.parts.head.getWorldPosition(out) : out; },
    // Start a bird's reaction, aimed at the feeder's world position. Returns the reaction type
    // (for the caller's matching burst), or null if the bird is busy / on cooldown.
    feed(id, feederPos, opts = {}) {
      const b = byId.get(id);
      if (!b || b.react || b.t - b.lastFed < FEED_COOLDOWN) return null;
      const dx = feederPos.x - b.x, dz = feederPos.z - b.z;
      const reduced = REDUCE || !!opts.reduced;
      b.react = { type: b.reaction, t: 0, dur: reduced ? 1.0 : REACT_DUR[b.reaction], reduced, faceYaw: Math.atan2(dx, dz) + Math.PI, home: { x: b.x, z: b.z } };
      return b.reaction;
    },
    dispose() { scene.remove(group); },
  };
}
