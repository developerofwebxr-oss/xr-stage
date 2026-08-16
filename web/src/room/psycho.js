import * as THREE from 'three';
import { loadGLB } from './gltf.js';

// room/psycho.js — assembles ONE real cyber-nostrich (the Psycho) from the owner's parts (4.15,
// re-derived 4.16 #1), decimated by scripts/process-nostrich01.mjs into public/nostrich01/.
// ADDITIVE: a single special bird, separate from the primitive flock; plugs into the flock brain
// via flock.addBird.
//
// Anatomy → the flock spec hierarchy so the same FK driver animates it:
//   body → neck_lower → neck_upper → head ;  body → leg_L, leg_R  (wings/tail are baked into the
//   body mesh → wing_L/wing_R/tail are empty pivots). Four head variants share the neck-top pivot;
//   exactly one visible (visibility swap).
//
// Every part's GLTF node already bakes R_x(+90°) (stands the Z-modelled parts upright). On top of
// that we apply a per-part ORIENT (to put feet/beak the right way) and a per-part TARGET HEIGHT (so
// proportions read right — the body is the mass, the head is small), then STACK by measured bounds.

const HEAD_STATES = ['normal', 'open_mouth', 'rage', 'psychotic_rage'];

// Per-part assembly spec, tuned against ~/Downloads/nostrich01 reference renders. `rot` = extra Euler
// (XYZ, on top of the node's R_x+90). `h` = target height in metres after scaling. Bird forward = −Z.
const SPEC = {
  legL:  { rot: [0, 0, 0], h: 0.95 },   // feet DOWN, toes forward
  legR:  { rot: [0, 0, 0], h: 0.95 },
  body:  { rot: [0, -Math.PI / 2, 0], h: 0.62 },  // long axis → fore-aft; neck-socket (−X) → −Z front (the mass)
  neckB: { rot: [0, 0, 0], h: 0.45 },   // wide base DOWN → narrow top up
  neckT: { rot: [0, 0, 0], h: 0.42 },
  head:  { rot: [0, 0, 0], h: 0.42 },   // beak forward (−Z), neck-socket down
};

// World-space vertex sample of an object (every `stride`-th vertex), for geometry-derived orientation.
function sampleVerts(obj, stride = 9) {
  obj.updateWorldMatrix(true, true);
  const pts = [], v = new THREE.Vector3();
  obj.traverse((o) => {
    const pos = o.isMesh && o.geometry?.attributes?.position;
    if (!pos) return;
    for (let i = 0; i < pos.count; i += stride) { pts.push(v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld).clone()); }
  });
  return pts;
}
function bounds3(obj) {
  obj.updateWorldMatrix(true, true);
  const box = new THREE.Box3().setFromObject(obj);
  return { box, size: box.getSize(new THREE.Vector3()), min: box.min.clone(), max: box.max.clone(), center: box.getCenter(new THREE.Vector3()) };
}
// Mean XZ radius of the vertices in the top vs bottom quarter (to tell a wide end from a narrow end).
function endRadii(pts) {
  let minY = Infinity, maxY = -Infinity;
  for (const p of pts) { minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
  const h = maxY - minY || 1, lo = [], hi = [];
  for (const p of pts) { if (p.y < minY + h * 0.25) lo.push(p); if (p.y > maxY - h * 0.25) hi.push(p); }
  const rad = (a) => { if (!a.length) return 0; let cx = 0, cz = 0; for (const p of a) { cx += p.x; cz += p.z; } cx /= a.length; cz /= a.length; let r = 0; for (const p of a) r += Math.hypot(p.x - cx, p.z - cz); return r / a.length; };
  return { lo: rad(lo), hi: rad(hi) };
}

export async function assemblePsycho() {
  const [body, neckB, neckT, legL, legR] = await Promise.all([
    'nostrich01/nostrich01_body.glb', 'nostrich01/nostrich01_neck_thick_bottom.glb', 'nostrich01/nostrich_neck_thin_top.glb',
    'nostrich01/nostrich01_left_leg.glb', 'nostrich01/nostrich01_right_leg.glb',
  ].map((f) => loadGLB(f)));
  const heads = {};
  for (const h of HEAD_STATES) heads[h] = await loadGLB(`nostrich01/nostrich01_head_${h}.glb`);
  if (!body || !neckB || !neckT || !legL || !legR || HEAD_STATES.some((h) => !heads[h])) {
    console.warn('[psycho] parts failed to load — not assembled'); return null;
  }

  // Wrap a raw part in a pivot group, apply its ORIENT + auto up-flip, scale to target height, and
  // seat its base (min.y) at y=0 within the group (centre it in x/z). Returns the pivot + its height.
  function fit(raw, spec, { flipRule } = {}) {
    const pivot = new THREE.Group();
    raw.rotation.set(spec.rot[0], spec.rot[1], spec.rot[2]);
    pivot.add(raw);
    // Auto up-flip from geometry: legs want the WIDE end (hip) up; necks want the wide end (base) down.
    if (flipRule) {
      const { lo, hi } = endRadii(sampleVerts(raw));
      const wideIsTop = hi > lo;
      const flip = flipRule === 'wide-up' ? !wideIsTop : wideIsTop; // wide-up: flip if wide is at bottom
      if (flip) { raw.rotation.z += Math.PI; raw.updateWorldMatrix(true, true); } // 180° keeps toe/front axis
    }
    const b0 = bounds3(raw);
    const s = spec.h / (b0.size.y || 1);
    raw.scale.setScalar(s); raw.updateWorldMatrix(true, true);
    const b = bounds3(raw);   // pivot-space bounds (pivot is at origin) → translate raw directly (no /s)
    raw.position.set(-b.center.x, -b.min.y, -b.center.z);   // base → y=0, centre x/z
    pivot.updateWorldMatrix(true, true);
    return { pivot, h: spec.h };
  }

  // Legs.
  const legFitL = fit(legL, SPEC.legL, { flipRule: 'wide-up' });
  const legFitR = fit(legR, SPEC.legR, { flipRule: 'wide-up' });
  const legGrpL = legFitL.pivot; legGrpL.name = 'leg_L';
  const legGrpR = legFitR.pivot; legGrpR.name = 'leg_R'; legGrpR.scale.x *= -1;   // mirror for the right side
  const legSpread = 0.24;
  legGrpL.position.set(-legSpread, 0, 0);
  legGrpR.position.set(legSpread, 0, 0);
  const hipY = legFitL.h;

  // Body — the mass, sits on the hips.
  const bodyFit = fit(body, SPEC.body); const bodyPivot = bodyFit.pivot; bodyPivot.name = 'body';
  bodyPivot.position.set(0, hipY - bodyFit.h * 0.15, 0);   // slight overlap onto the hips

  // Neck lower — wide base seated on the body's front-top.
  const neckBFit = fit(neckB, SPEC.neckB, { flipRule: 'wide-down' }); const neckLower = neckBFit.pivot; neckLower.name = 'neck_lower';
  neckLower.position.set(0, bodyFit.h * 0.72, -bodyFit.h * 0.35);

  // Neck upper — on top of neck lower.
  const neckTFit = fit(neckT, SPEC.neckT, { flipRule: 'wide-down' }); const neckUpper = neckTFit.pivot; neckUpper.name = 'neck_upper';
  neckUpper.position.set(0, neckBFit.h * 0.85, 0.02);

  // Head pivot — four variants share it (visibility swap). Beak forward, neck-socket down.
  const headPivot = new THREE.Group(); headPivot.name = 'head';
  let headH = 0.42;
  for (const h of HEAD_STATES) {
    const hf = fit(heads[h], SPEC.head); hf.pivot.name = `head_${h}`; hf.pivot.visible = h === 'normal';
    headPivot.add(hf.pivot); headH = hf.h;
  }
  headPivot.position.set(0, neckTFit.h * 0.85, 0.02);

  // Empty FK pivots (wings/tail baked into the body mesh).
  const wingL = new THREE.Group(); wingL.name = 'wing_L';
  const wingR = new THREE.Group(); wingR.name = 'wing_R';
  const tail = new THREE.Group(); tail.name = 'tail';

  neckUpper.add(headPivot); neckLower.add(neckUpper);
  bodyPivot.add(neckLower, wingL, wingR, tail);
  const rig = new THREE.Group(); rig.name = 'ostrich';
  rig.add(bodyPivot, legGrpL, legGrpR);

  // Ground the feet at y=0 (shift the top-level children, leaving root.y free for placement).
  rig.updateMatrixWorld(true);
  const gb = bounds3(rig);
  for (const c of [bodyPivot, legGrpL, legGrpR]) c.position.y -= gb.min.y;
  rig.updateMatrixWorld(true);
  const total = bounds3(rig).size.y;

  function setHead(state) { for (const h of HEAD_STATES) headPivot.getObjectByName(`head_${h}`).visible = h === state; }
  setHead('normal');

  const parts = { body: bodyPivot, neckL: neckLower, neckU: neckUpper, head: headPivot, legL: legGrpL, legR: legGrpR, wingL, wingR };
  return { root: rig, parts, setHead, scale: 1, heightM: +total.toFixed(2) };
}
