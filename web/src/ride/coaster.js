import * as THREE from 'three';
import { loadGLB, fitToHeight, measure } from '../room/gltf.js';

// ride/coaster.js — the Nostrich Park roller coaster (4.10). ONE editable waypoint route →
// a closed CatmullRom curve; rails = a tube swept along it + periodic ties. The train is
// assembled from the owner GLBs (front + N identical carts); if a GLB is absent the cart is a
// primitive placeholder (async-absence rule). Ride loop is a small state machine driven by the
// caller (board → countdown → run → return). Diegetic (visible in AR). Curve samples are cached.
//
//   createCoaster(scene, { nCarts, onDepart, onReturn }) → {
//     group, update(dt), ready, seats(), seatWorldPos(id,out), tangentAt(u,out),
//     state(), boardable(), beginBoarding(), countdown(), trainU() }

// ── ROUTE (the one editable array) — world XYZ. Station in the park → climb over the stage →
// bank above Networking & Smoking → dive through the forest → weave the pens → return. The peak
// clears the stage at y≈14 m, ~5 m above the screen top (~8.7 m) so it never occludes the boards.
const WAYPOINTS = [
  [20, 1.2, 16],   // station platform (park)
  [12, 7, 6],      // climb out of the park toward the stage
  [0, 14, -7],     // PEAK over the stage (high clearance over the screen)
  [8, 11, 22],     // bank above Networking
  [-14, 10, 20],   // bank above Smoking
  [-25, 5, 4],     // dive through the forest
  [-6, 3, -2],     // low pass in front of the plaza
  [24, 3, 24],     // weave behind the pens
  [26, 2.2, 12],   // swing back
  [22, 1.4, 17],   // approach the station
];
const DEPART_S = 20;      // countdown after first boarding
const RUN_S = 78;         // nominal lap time (speed varies with slope)
const CART_GAP = 0.052;   // spacing between carts in curve-param space
const SEAT_DX = 0.34;     // half-gap between the two seats in a cart

export function createCoaster(scene, { nCarts = 4, onDepart, onReturn } = {}) {
  const group = new THREE.Group(); group.name = 'coaster';
  scene.add(group);

  const curve = new THREE.CatmullRomCurve3(WAYPOINTS.map((p) => new THREE.Vector3(...p)), true, 'catmullrom', 0.5);
  const LEN = curve.getLength();

  // ── Rails: a tube along the curve + periodic ties (cheap; one geometry each). ──
  const rail = new THREE.Mesh(
    new THREE.TubeGeometry(curve, 240, 0.12, 6, true),
    new THREE.MeshStandardMaterial({ color: 0x6a4a7a, roughness: 0.7, metalness: 0.2 }),
  );
  group.add(rail);
  const tieGeo = new THREE.BoxGeometry(0.9, 0.06, 0.16);
  const tieMat = new THREE.MeshStandardMaterial({ color: 0xff5aa8, roughness: 0.6, emissive: 0x2a0f1e });
  const TIES = 90;
  const ties = new THREE.InstancedMesh(tieGeo, tieMat, TIES);
  const _p = new THREE.Vector3(), _t = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0), _m = new THREE.Matrix4(), _q = new THREE.Quaternion();
  for (let i = 0; i < TIES; i++) {
    const u = i / TIES;
    curve.getPointAt(u, _p); curve.getTangentAt(u, _t);
    _q.setFromRotationMatrix(_m.lookAt(_p, _p.clone().add(_t), _up));
    ties.setMatrixAt(i, _m.compose(_p, _q, new THREE.Vector3(1, 1, 1)));
  }
  ties.instanceMatrix.needsUpdate = true; ties.frustumCulled = false;
  group.add(ties);

  // ── Station platform at u=0. ──
  curve.getPointAt(0, _p);
  const platform = new THREE.Mesh(new THREE.BoxGeometry(4, 0.3, 6), new THREE.MeshStandardMaterial({ color: 0x2a2030, roughness: 0.9 }));
  platform.position.set(_p.x, _p.y - 0.35, _p.z + 1.2);
  group.add(platform);

  // ── Train: carts along the curve. Front + (nCarts-1) carts; each seats 2. ──
  const carts = [];
  const seatList = [];
  function placeholderCart(front) {
    const g = new THREE.Group();
    const hull = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.5, 1.3), new THREE.MeshStandardMaterial({ color: front ? 0xff5aa8 : 0xd23f86, roughness: 0.6, emissive: 0x1a0a12 }));
    hull.position.y = 0.35; g.add(hull);
    if (front) { const nose = new THREE.Mesh(new THREE.ConeGeometry(0.35, 0.7, 8), hull.material); nose.rotation.x = -Math.PI / 2; nose.position.set(0, 0.4, -0.9); g.add(nose); }
    return g;
  }
  function buildCart(model, front, idx) {
    const cart = new THREE.Group(); cart.name = front ? 'roller_front' : `roller_cart_${idx}`;
    const visual = model || placeholderCart(front);
    if (model) fitToHeight(model, 1.4);   // fit the GLB to ~1.4 m
    cart.add(visual);
    group.add(cart);
    // Seat anchors: named 'seat_L'/'seat_R' nodes if the GLB has them, else two computed offsets.
    for (const side of ['L', 'R']) {
      let anchor = model ? model.getObjectByName(`seat_${side}`) : null;
      if (!anchor) { anchor = new THREE.Object3D(); anchor.position.set(side === 'L' ? -SEAT_DX : SEAT_DX, 0.55, 0.15); cart.add(anchor); }
      const id = `${idx}:${side}`;
      // A small pad on the seat → raycast target for boarding (userData.rideSeat = id).
      const pad = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.06, 0.34), new THREE.MeshStandardMaterial({ color: 0xffd0e6, emissive: 0x3a1226, roughness: 0.6 }));
      pad.userData.rideSeat = id;
      anchor.add(pad);
      seatList.push({ id, cartIdx: idx, side, anchor, pad, occupied: false });
    }
    carts.push({ cart, front, idx });
  }

  let ready = false;
  (async () => {
    // Load the two GLBs once; clone the cart model per repeated cart. Graceful on absence.
    const [front, cartModel] = await Promise.all([loadGLB('/nostrich_roller_front.glb'), loadGLB('/nostrich_roller_cart.glb')]);
    buildCart(front, true, 0);
    for (let i = 1; i < nCarts; i++) buildCart(cartModel ? cartModel.clone(true) : null, false, i);
    ready = true;
    layoutTrain();
    if (!front && !cartModel) console.warn('[coaster] GLBs absent — using primitive placeholder carts');
  })();

  // ── Ride state ──
  let mode = 'idle';        // 'idle' | 'boarding' | 'running'
  let u = 0;                // front cart curve param
  let boardT = 0;           // boarding countdown remaining
  const _cp = new THREE.Vector3(), _ct = new THREE.Vector3();

  function layoutTrain() {
    for (const c of carts) {
      const cu = (u - c.idx * CART_GAP + 1) % 1;
      curve.getPointAt(cu, _cp); curve.getTangentAt(cu, _ct);
      c.cart.position.copy(_cp);
      c.cart.quaternion.setFromRotationMatrix(_m.lookAt(_cp, _cp.clone().add(_ct), _up));
    }
  }

  function update(dt) {
    if (!ready) return;
    if (mode === 'boarding') {
      boardT -= dt;
      if (boardT <= 0) { mode = 'running'; onDepart && onDepart(); }
    } else if (mode === 'running') {
      // Slope-aware speed: slow on the climbs (tangent.y > 0), fast on the dives.
      curve.getTangentAt(u, _ct);
      const slope = _ct.y;                       // -1..1
      const speed = (1 / RUN_S) * THREE.MathUtils.clamp(1 - slope * 1.4, 0.35, 2.2);
      u += speed * dt;
      if (u >= 1) { u = 0; mode = 'idle'; onReturn && onReturn(); }
    }
    layoutTrain();
  }

  const seatById = (id) => seatList.find((s) => s.id === id);
  return {
    group,
    update,
    get ready() { return ready; },
    seats: () => seatList,
    seatPads: () => seatList.map((s) => s.pad).filter(Boolean),
    occupy: (id, on) => { const s = seatById(id); if (s) s.occupied = on; },
    isOccupied: (id) => !!seatById(id)?.occupied,
    seatAnchor: (id) => seatById(id)?.anchor || null,
    seatWorldPos: (id, out) => { const a = seatById(id)?.anchor; if (a) a.getWorldPosition(out); return out; },
    tangentAt: (out) => curve.getTangentAt(u, out),
    state: () => mode,
    boardable: () => mode === 'idle',
    beginBoarding: () => { if (mode === 'idle') { mode = 'boarding'; boardT = DEPART_S; } },
    countdown: () => (mode === 'boarding' ? Math.ceil(boardT) : 0),
    trainU: () => u,
    stationInfo: () => ({ pos: curve.getPointAt(0, new THREE.Vector3()), lenM: Math.round(LEN) }),
    dispose() { scene.remove(group); },
  };
}
