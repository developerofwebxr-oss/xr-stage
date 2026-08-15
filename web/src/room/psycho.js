import * as THREE from 'three';
import { loadGLB, measure } from './gltf.js';

// room/psycho.js — assembles ONE real cyber-nostrich (the Psycho) from the owner's parts (4.15),
// decimated by scripts/process-nostrich01.mjs into public/nostrich01/. ADDITIVE: this is a single
// special bird, separate from the primitive flock; it plugs into the flock brain via flock.addBird.
//
// Anatomy → the flock spec hierarchy so the same FK driver animates it:
//   body → neck_lower → neck_upper → head ;  body → leg_L, leg_R  (wings/tail are baked into the
//   body mesh, so wing_L/wing_R/tail are empty pivots — the FK guards on missing parts).
// Four head variants mount on the SAME neck-top pivot; exactly one is visible (visibility swap).
//
// Parts are individually origin-centred and modelled lying along local Z (legs/neck) or long-X
// (body); heads are upright with the beak toward −X. We orient each into a common frame (bird
// forward = −Z, to match the flock), then STACK by measured bounds so joints meet without magic
// vertical offsets. Import-time fixes only — the source files in ~/Downloads are never touched.

const HEAD_STATES = ['normal', 'open_mouth', 'rage', 'psychotic_rage'];
const TARGET_H = 2.0;   // assembled standing height, metres (reported)

// Per-part orientation (Euler XYZ, radians) to bring each into the assembly frame, tuned to the
// reference renders. Bird forward = −Z; up = +Y.
// Every part's GLTF node already bakes R_x(+90°), which stands the Z-modelled parts upright — so we
// do NOT re-rotate legs/neck/head. Only the body's horizontal length needs turning to fore-aft.
const ORIENT = {
  body:  [0, Math.PI / 2, 0],    // horizontal egg → long axis along Z (fore-aft)
  neckB: [Math.PI, 0, 0],        // flip so the wide base is DOWN / socket up
  neckT: [Math.PI, 0, 0],
  legL:  [Math.PI, 0, 0],        // flip so the foot is DOWN / hip up
  legR:  [Math.PI, 0, 0],
  head:  [0, 0, 0],
};

const orient = (obj, e) => { obj.rotation.set(e[0], e[1], e[2]); obj.updateWorldMatrix(true, true); };
// Bounds of an object (force-updates the whole matrix chain first, so mid-assembly re-parents +
// rotations are always reflected — the default setFromObject can read a stale matrixWorld).
function localBounds(obj) {
  obj.updateWorldMatrix(true, true);
  const box = new THREE.Box3().setFromObject(obj);
  return { box, size: box.getSize(new THREE.Vector3()), min: box.min, max: box.max, center: box.getCenter(new THREE.Vector3()) };
}

export async function assemblePsycho() {
  const files = {
    body: 'nostrich01/nostrich01_body.glb',
    neckB: 'nostrich01/nostrich01_neck_thick_bottom.glb',
    neckT: 'nostrich01/nostrich_neck_thin_top.glb',
    legL: 'nostrich01/nostrich01_left_leg.glb',
    legR: 'nostrich01/nostrich01_right_leg.glb',
  };
  const [body, neckB, neckT, legL, legR] = await Promise.all([files.body, files.neckB, files.neckT, files.legL, files.legR].map((f) => loadGLB(f)));
  const heads = {};
  for (const h of HEAD_STATES) heads[h] = await loadGLB(`nostrich01/nostrich01_head_${h}.glb`);
  if (!body || !neckB || !neckT || !legL || !legR || HEAD_STATES.some((h) => !heads[h])) {
    console.warn('[psycho] one or more parts failed to load — Psycho not assembled');
    return null;
  }

  // ── Assemble in a working group (unit scale), then normalise scale + ground it. ──
  const rig = new THREE.Group(); rig.name = 'ostrich';   // flock-compatible root

  // Orient each raw part.
  orient(body, ORIENT.body); orient(neckB, ORIENT.neckB); orient(neckT, ORIENT.neckT);
  orient(legL, ORIENT.legL); orient(legR, ORIENT.legR);
  for (const h of HEAD_STATES) orient(heads[h], ORIENT.head);

  // Legs — stand under the body, feet at y=0, toed forward (−Z). Mirror R across X.
  const legGrpL = new THREE.Group(); legGrpL.name = 'leg_L'; legGrpL.add(legL);
  const legGrpR = new THREE.Group(); legGrpR.name = 'leg_R'; legGrpR.add(legR);
  legGrpR.scale.x = -1;                                   // mirror the left leg for the right
  for (const [grp, part] of [[legGrpL, legL], [legGrpR, legR]]) {
    const b = localBounds(part);
    part.position.y -= b.min.y;                           // foot to y=0 within the leg group
  }
  const legB = localBounds(legL);
  const legTopY = legB.max.y - legB.min.y;                // hip height
  const legSpread = 0.16;                                 // half the stance width (scaled later)
  legGrpL.position.set(-legSpread, 0, 0);
  legGrpR.position.set(legSpread, 0, 0);

  // Body — sits on the hips. Centre it over the legs, its lowest point ~at the hip line.
  const JOIN = 0.9;   // stack each part's base at ~90% of the parent's top (slight overlap = house style)
  const bodyPivot = new THREE.Group(); bodyPivot.name = 'body'; bodyPivot.add(body);
  { const b = localBounds(body); body.position.y -= b.center.y; body.position.z -= b.center.z; body.position.x -= b.center.x; }
  const bodyH = localBounds(body).size.y, bodyZ = localBounds(body).size.z;
  bodyPivot.position.set(0, legTopY + bodyH * 0.5 * JOIN, 0);   // body bottom on the hips

  // Neck lower — base seated on the body's front-top, socket up. (Content base at y=0 in its group.)
  const neckLower = new THREE.Group(); neckLower.name = 'neck_lower'; neckLower.add(neckB);
  { const b = localBounds(neckB); neckB.position.y -= b.min.y; neckB.position.x -= b.center.x; neckB.position.z -= b.center.z; }
  const neckBH = localBounds(neckB).size.y;
  neckLower.position.set(0, bodyH * 0.5 * JOIN, -bodyZ * 0.30);  // front-top of the body

  // Neck upper — stacked on top of neck lower (long neck).
  const neckUpper = new THREE.Group(); neckUpper.name = 'neck_upper'; neckUpper.add(neckT);
  { const b = localBounds(neckT); neckT.position.y -= b.min.y; neckT.position.x -= b.center.x; neckT.position.z -= b.center.z; }
  const neckTH = localBounds(neckT).size.y;
  neckUpper.position.set(0, neckBH * JOIN, -0.02);

  // Head pivot — all four variants share it (visibility swap). Neck-socket (bottom) seats on the top.
  const headPivot = new THREE.Group(); headPivot.name = 'head';
  for (const h of HEAD_STATES) {
    const grp = new THREE.Group(); grp.name = `head_${h}`; grp.add(heads[h]);
    const b = localBounds(heads[h]); heads[h].position.y -= b.min.y; heads[h].position.x -= b.center.x; heads[h].position.z -= b.center.z;
    grp.visible = h === 'normal';
    headPivot.add(grp);
  }
  headPivot.position.set(0, neckTH * JOIN, -0.04);

  // Empty pivots for FK-name compatibility (wings/tail are baked into the body mesh).
  const wingL = new THREE.Group(); wingL.name = 'wing_L';
  const wingR = new THREE.Group(); wingR.name = 'wing_R';
  const tail = new THREE.Group(); tail.name = 'tail';

  // Parent chain: body → neck_lower → neck_upper → head ; body → legs, wings, tail.
  neckUpper.add(headPivot); neckLower.add(neckUpper);
  bodyPivot.add(neckLower, wingL, wingR, tail);
  rig.add(bodyPivot, legGrpL, legGrpR);

  // Normalise scale to ~TARGET_H and ground the feet at y=0.
  rig.updateMatrixWorld(true);
  const all = localBounds(rig);
  const scale = TARGET_H / all.size.y;
  rig.scale.setScalar(scale);
  rig.updateMatrixWorld(true);
  const grounded = localBounds(rig);
  // Ground the feet by shifting the CONTENT (not rig.position), so callers can freely place root.y=0.
  for (const child of [bodyPivot, legGrpL, legGrpR]) child.position.y -= grounded.min.y / scale;

  // Head-state API: exactly one visible.
  function setHead(state) {
    for (const h of HEAD_STATES) headPivot.getObjectByName(`head_${h}`).visible = h === state;
  }
  setHead('normal');

  const parts = {
    body: bodyPivot, neckL: neckLower, neckU: neckUpper, head: headPivot,
    legL: legGrpL, legR: legGrpR, wingL, wingR,
  };
  return { root: rig, parts, setHead, scale, heightM: TARGET_H };
}
