import * as THREE from 'three';
import { loadGLB, fitToHeight, measure } from '../room/gltf.js';
import { STAGE_POS, SCREEN } from '../room/zones.js';

// ride/coaster.js — the Nostrich Coaster (4.10 · re-profiled + frame-stabilised 4.12).
//
// ROUTE = one editable waypoint array → a closed CatmullRom. Rails = a tube + instanced ties.
// Train = the owner GLBs (front + N carts) with primitive placeholders on absence.
//
// ORIENTATION (4.12 #2): carts + the seated rig are oriented with PARALLEL-TRANSPORT frames
// (precomputed + cached), NOT naive lookAt/world-up. Parallel transport carries the up vector
// along the curve by the minimal rotation between successive tangents, so the frame never SNAPS
// where the tangent nears vertical or the curvature inverts (the classic Frenet flip that threw
// riders out of the cart). A closed-loop twist correction makes UP[N] meet UP[0]. Banking is a
// clamped roll (≤35°) ADDED to that stable frame. The seated rig inherits the seat anchor's world
// quaternion — the SAME transform source as the cart, no separate lookAt.
//
// PROFILE (4.12 #3): peaks raised to a skyline; nothing over the stage/boards footprint passes
// below the sponsor-ticker band + 2 m; descents are gravity-flavoured (speed ∝ drop, clamped),
// climbs stay slow, loop tuned into the 60–90 s envelope. A build-time self-check logs the
// clearance / heights / speeds / max frame-to-frame up-delta.

// ── ROUTE — world XYZ. Station (park) → climb → SKYLINE peak → SUPER peak (the extreme high) →
// steep drop → a VERTICAL INVERSION LOOP (4.13 #6) → rejoin the back circuit → dive → return.
// Every point within the stage footprint stays high; the low/fast bits + the loop are out over the
// plaza (clear of the stage, Networking and Smoking). Closed curve: last point → station.
//
// The loop is GENERATED as a true circle in the (travel, up) plane entered at its BOTTOM, with a
// small forward corkscrew drift so entry ≠ exit. A real circle → a clean inversion, which is the
// stress test the 4.12 parallel-transport frames must survive without snapping.
// Park-side waypoints follow the park's move OUT to Networking's radius (4.17 #3): the station is now
// at radius ~34 (≈ (22.3,18.6)); the peak / inversion / stage-side are unchanged so stage clearance holds.
const PRE = [
  [22.3, 1.6, 18.6], // station (park) — leaves heading −x,−z
  [17, 8, 11],       // climb out of the park
  [4, 18, -2],       // steep climb toward the stage
  [-2, 27, -8],      // SKYLINE peak over the stage
  [-11, 35, -6],     // SUPER peak — the extreme high (skyline moment)
  [-16, 20, 4],      // steep, fast drop begins
  [-19, 9, 9],       // pull-out: level into the loop bottom, moving +z
];
const POST = [
  [-8, 9, 26],       // rejoin: low bank behind (near Smoking)
  [8, 9, 28],        // across the back (above Networking)
  [24, 7, 27],       // curve to +x, descending
  [31, 3, 19],       // the big DIVE (far +x, low, fast)
  [26, 2, 23],       // sweep back toward the station (aligns to −x,−z)
];
function buildLoop() {
  const E = new THREE.Vector3(-18, 8, 14);                    // loop bottom (entry)
  const d = new THREE.Vector3(0.243, 0, 0.970).normalize();  // horizontal travel dir at entry
  const up = new THREE.Vector3(0, 1, 0);
  const R = 8, ADV = 7, STEPS = 9;                           // radius · corkscrew drift · samples
  const Cl = E.clone().addScaledVector(up, R);               // centre: R directly above the entry
  const pts = [];
  for (let k = 0; k <= STEPS; k++) {
    const phi = (k / (STEPS + 1)) * Math.PI * 2;             // 0 (bottom) → 0.9·2π (exclusive of the seam)
    const p = Cl.clone()
      .addScaledVector(d, Math.sin(phi) * R + (phi / (Math.PI * 2)) * ADV)
      .addScaledVector(up, -Math.cos(phi) * R);              // −cos: φ=0 → bottom, φ=π → inverted top
    pts.push([p.x, p.y, p.z]);
  }
  return pts;
}
const WAYPOINTS = [...PRE, ...buildLoop(), ...POST];
const DEPART_S = 20;      // countdown after first boarding
const RUN_S = 60;         // nominal lap time (before slope coupling) — tuned into the 60–90 s envelope
const CART_GAP = 0.05;    // cart spacing in curve-param space
const N = 512;            // frame/sample cache resolution (dense → small per-sample frame steps)
const BANK_MAX = THREE.MathUtils.degToRad(28);
const SLOPE_K = 2.6, SPEED_MIN = 0.32, SPEED_MAX = 3.1; // gravity coupling: slow climbs, fast dives
// Sponsor-ticker band sits just above the main screen; nothing over the stage footprint may pass
// below TICKER_TOP + 2 m. (No ticker mesh yet — anchored to the screen top.)
const TICKER_TOP = SCREEN.y + SCREEN.h / 2 + 1.0;   // ≈ 9.75 m
const MIN_CLEAR = TICKER_TOP + 2;                    // ≈ 11.75 m
const FOOTPRINT_R = 10;                              // stage/boards footprint radius (XZ, from STAGE_POS)

export function createCoaster(scene, { nCarts = 4, onDepart, onReturn } = {}) {
  const group = new THREE.Group(); group.name = 'coaster';
  scene.add(group);

  // 'centripetal' Catmull-Rom avoids the cusps/overshoots that plain catmullrom makes at sharp
  // control points — those near-cusps reverse the tangent and blow up parallel transport (the flip).
  const curve = new THREE.CatmullRomCurve3(WAYPOINTS.map((p) => new THREE.Vector3(...p)), true, 'centripetal');
  const LEN = curve.getLength();

  // ── Parallel-transport frames along the curve (cached: position, tangent, banked up) ──
  const P = [], T = [], UP = [], BANK = new Float32Array(N + 1);
  for (let i = 0; i <= N; i++) { P[i] = curve.getPointAt(i / N, new THREE.Vector3()); T[i] = curve.getTangentAt(i / N, new THREE.Vector3()).normalize(); }
  // initial up = world-up made perpendicular to T0
  { const u0 = new THREE.Vector3(0, 1, 0); u0.addScaledVector(T[0], -u0.dot(T[0])); if (u0.lengthSq() < 1e-6) { u0.set(1, 0, 0); u0.addScaledVector(T[0], -u0.dot(T[0])); } UP[0] = u0.normalize(); }
  const _pq = new THREE.Quaternion();
  for (let i = 1; i <= N; i++) {
    _pq.setFromUnitVectors(T[i - 1], T[i]);              // minimal rotation prev→cur tangent
    UP[i] = UP[i - 1].clone().applyQuaternion(_pq);
    UP[i].addScaledVector(T[i], -UP[i].dot(T[i])).normalize(); // re-orthogonalise to the tangent
  }
  // Closed-loop: distribute the residual twist between UP[N] and UP[0] so the frame is seamless.
  { const cross = new THREE.Vector3().crossVectors(UP[N], UP[0]); const resid = Math.atan2(cross.dot(T[0]), UP[N].dot(UP[0])); for (let i = 0; i <= N; i++) UP[i].applyAxisAngle(T[i], resid * (i / N)).normalize(); }
  // SMOOTH the transported up-frame (4.12 #2): parallel transport is continuous but can still carry
  // a locally-steep twist wherever the curve turns hard. Several neighbour-blend passes (each
  // re-orthogonalised to the tangent) SPREAD any such spike across its neighbourhood, so no single
  // frame-to-frame step snaps — the up direction changes gradually everywhere. Blends across the
  // closed seam (i-1 / i+1 wrap) so the loop stays seamless.
  for (let pass = 0; pass < 160; pass++) {
    const prev = UP.map((u) => u.clone());
    for (let i = 0; i <= N; i++) {
      const a = prev[(i - 1 + N + 1) % (N + 1)], b = prev[(i + 1) % (N + 1)];
      UP[i].copy(prev[i]).multiplyScalar(2).add(a).add(b);                 // 2:1:1 neighbour blend
      UP[i].addScaledVector(T[i], -UP[i].dot(T[i])).normalize();           // keep ⟂ tangent
    }
  }
  // Banking: roll the up toward the turn, ∝ horizontal turn rate, clamped. Heavily smoothed so the
  // roll itself never adds a snap on top of the stable frame (a wide box filter spreads it out).
  const rawBank = new Float32Array(N + 1);
  for (let i = 0; i <= N; i++) {
    const a = (i - 2 + N + 1) % (N + 1), b = (i + 2) % (N + 1);
    const ya = Math.atan2(T[a].x, T[a].z), yb = Math.atan2(T[b].x, T[b].z);
    const dy = Math.atan2(Math.sin(yb - ya), Math.cos(yb - ya));   // yaw delta over ~4 samples
    // Fade banking out as the track steepens: horizontal-turn lean is meaningless (and the yaw is
    // numerically unstable) where the tangent nears vertical — e.g. through the inversion loop, which
    // must roll purely on the parallel-transport frame, never on this heuristic.
    const horiz = Math.max(0, 1 - Math.abs(T[i].y) / 0.5);
    rawBank[i] = THREE.MathUtils.clamp(-dy * 3.0, -1, 1) * BANK_MAX * horiz; // toward the turn centre (gentle gain)
  }
  { const W = 9; for (let pass = 0; pass < 3; pass++) { const src = BANK.slice ? Float32Array.from(pass === 0 ? rawBank : BANK) : rawBank; for (let i = 0; i <= N; i++) { let s = 0; for (let k = -W; k <= W; k++) s += src[(i + k + N + 1) % (N + 1)]; BANK[i] = s / (2 * W + 1); } } } // wide box filter, 3 passes
  const UPB = UP.map((u, i) => u.clone().applyAxisAngle(T[i], BANK[i]).normalize());
  // Smooth the BANKED frame too: at a hard turn the roll rides on a fast-swinging tangent, which can
  // re-introduce a per-sample step even when PT and BANK are each smooth. A few neighbour-blend passes
  // (⟂-tangent re-orthogonalised, seam-wrapped) cap the banked frame's per-sample delta as well.
  for (let pass = 0; pass < 30; pass++) {
    const prev = UPB.map((u) => u.clone());
    for (let i = 0; i <= N; i++) {
      const a = prev[(i - 1 + N + 1) % (N + 1)], b = prev[(i + 1) % (N + 1)];
      UPB[i].copy(prev[i]).multiplyScalar(2).add(a).add(b);
      UPB[i].addScaledVector(T[i], -UPB[i].dot(T[i])).normalize();
    }
  }
  const idxAt = (uu) => { let i = Math.round(((uu % 1) + 1) % 1 * N); if (i > N) i = N; return i; };
  // Precompute the per-sample orientation as a quaternion, then SLERP between samples at runtime so
  // the cart (and the seated rig that inherits its world quaternion) rotates continuously — never a
  // per-sample step. QUAT[N] ≈ QUAT[0] after the closed-loop correction, so the seam is seamless.
  const QUAT = []; { const _qm = new THREE.Matrix4(), _ql = new THREE.Vector3(); for (let i = 0; i <= N; i++) { const q = new THREE.Quaternion(); q.setFromRotationMatrix(_qm.lookAt(P[i], _ql.copy(P[i]).add(T[i]), UPB[i])); QUAT[i] = q; } }
  const _qa = new THREE.Quaternion();
  // Continuous pose at curve-param uu → writes position + quaternion (lerp P, slerp QUAT).
  function poseAt(uu, outPos, outQuat) {
    const s = (((uu % 1) + 1) % 1) * N; const i0 = Math.min(N - 1, Math.floor(s)); const f = s - i0;
    outPos.copy(P[i0]).lerp(P[i0 + 1], f);
    outQuat.copy(QUAT[i0]).slerp(QUAT[i0 + 1], f);
  }

  // ── Rails: a tube along the curve + instanced ties (built once) ──
  const rail = new THREE.Mesh(new THREE.TubeGeometry(curve, 260, 0.12, 6, true), new THREE.MeshStandardMaterial({ color: 0x6a4a7a, roughness: 0.7, metalness: 0.2 }));
  group.add(rail);
  const ties = new THREE.InstancedMesh(new THREE.BoxGeometry(0.9, 0.06, 0.16), new THREE.MeshStandardMaterial({ color: 0xff5aa8, roughness: 0.6, emissive: 0x2a0f1e }), 110);
  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _look = new THREE.Vector3(), _one = new THREE.Vector3(1, 1, 1);
  for (let i = 0; i < 110; i++) { const j = idxAt(i / 110); _q.setFromRotationMatrix(_m.lookAt(P[j], _look.copy(P[j]).add(T[j]), UPB[j])); ties.setMatrixAt(i, _m.compose(P[j], _q, _one)); }
  ties.instanceMatrix.needsUpdate = true; ties.frustumCulled = false; group.add(ties);

  // ── Station RIDE post (4.13 #5) ──────────────────────────────────────────────────
  // No platform slab (track + carts sit at ground/ride level). Boarding is an OBVIOUS affordance:
  // a glowing post whose canvas label reads "RIDE ⚡210" (idle), the live departure countdown while
  // boarding, then "RIDING…". Selecting it (unified raycast → userData.rideButton) pays + seat-snaps
  // the picker into the next free seat; a second guest selects into the next one. A glowing floor
  // ring marks where to stand.
  const postX = P[0].x + 1.5, postZ = P[0].z - 1.2;    // beside the station, facing the plaza approach
  const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.12, 1.6, 10),
    new THREE.MeshStandardMaterial({ color: 0x241c2a, emissive: 0xff5aa8, emissiveIntensity: 0.4, roughness: 0.5 }));
  pillar.position.set(postX, 0.8, postZ); group.add(pillar);
  const postCanvas = document.createElement('canvas'); postCanvas.width = 384; postCanvas.height = 256;
  const pg = postCanvas.getContext('2d');
  const postTex = new THREE.CanvasTexture(postCanvas); postTex.colorSpace = THREE.SRGBColorSpace;
  const postLabel = new THREE.Mesh(new THREE.PlaneGeometry(1.15, 0.77), new THREE.MeshBasicMaterial({ map: postTex, transparent: true }));
  postLabel.position.set(postX, 1.85, postZ); postLabel.rotation.y = Math.PI;   // face the plaza (−z)
  postLabel.userData.rideButton = true; group.add(postLabel);
  const standRing = new THREE.Mesh(new THREE.RingGeometry(0.5, 0.64, 28),
    new THREE.MeshBasicMaterial({ color: 0xff5aa8, transparent: true, opacity: 0.55, side: THREE.DoubleSide }));
  standRing.rotation.x = -Math.PI / 2; standRing.position.set(postX - 0.3, 0.03, postZ + 1.0); group.add(standRing);
  let _postState = '';
  function drawPost() {
    const key = mode === 'boarding' ? `cd${Math.ceil(boardT)}` : mode;
    if (key === _postState) return;                    // re-texture only on change (cheap)
    _postState = key;
    pg.clearRect(0, 0, 384, 256);
    postRoundRect(pg, 6, 6, 372, 244, 22);
    pg.fillStyle = 'rgba(11,13,19,0.92)'; pg.fill();
    pg.lineWidth = 4; pg.strokeStyle = mode === 'idle' ? '#ff5aa8' : 'rgba(255,90,168,0.5)'; pg.stroke();
    pg.textAlign = 'center'; pg.textBaseline = 'middle';
    if (mode === 'idle') {
      pg.fillStyle = '#ff5aa8'; pg.font = '700 66px ui-monospace, Menlo, monospace'; pg.fillText('RIDE', 192, 98);
      pg.fillStyle = '#f7931a'; pg.font = '700 54px ui-monospace, Menlo, monospace'; pg.fillText('⚡ 210', 192, 170);
    } else if (mode === 'boarding') {
      pg.fillStyle = '#eceef5'; pg.font = '600 40px ui-monospace, Menlo, monospace'; pg.fillText('DEPARTS', 192, 90);
      pg.fillStyle = '#f7931a'; pg.font = '700 96px ui-monospace, Menlo, monospace'; pg.fillText(`${Math.ceil(boardT)}s`, 192, 172);
    } else {
      pg.fillStyle = '#9b6cff'; pg.font = '700 56px ui-monospace, Menlo, monospace'; pg.fillText('RIDING…', 192, 128);
    }
    postTex.needsUpdate = true;
  }

  // ── Train ──
  const carts = [], seatList = [];
  let seatDX = 0.34, seatY = 0.55, seatZ = 0.1;   // seat offsets — overwritten from real cart bounds
  function placeholderCart(front) {
    const g = new THREE.Group();
    const hull = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.5, 1.3), new THREE.MeshStandardMaterial({ color: front ? 0xff5aa8 : 0xd23f86, roughness: 0.6, emissive: 0x1a0a12 }));
    hull.position.y = 0.35; g.add(hull);
    if (front) { const nose = new THREE.Mesh(new THREE.ConeGeometry(0.35, 0.7, 8), hull.material); nose.rotation.x = -Math.PI / 2; nose.position.set(0, 0.4, -0.9); g.add(nose); }
    return g;
  }
  function buildCart(model, front, idx) {
    const cart = new THREE.Group(); cart.name = front ? 'roller_front' : `roller_cart_${idx}`;
    // The cart's local −Z is the travel direction (lookAt(P, P+T, up)). The owner's front-cart GLB
    // is modelled facing the other way, so the bird rode backwards (4.13 #3) — spin it 180° so the
    // beak leads. Only the front carries the bird; the N plain carts are symmetric, left as-is.
    if (model && front) model.rotation.y = Math.PI;
    cart.add(model || placeholderCart(front));
    group.add(cart);
    for (const side of ['L', 'R']) {
      let anchor = model ? model.getObjectByName(`seat_${side}`) : null;   // named seat nodes if present
      if (!anchor) { anchor = new THREE.Object3D(); anchor.position.set(side === 'L' ? -seatDX : seatDX, seatY, seatZ); cart.add(anchor); }
      const id = `${idx}:${side}`;
      const pad = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.06, 0.34), new THREE.MeshStandardMaterial({ color: 0xffd0e6, emissive: 0x3a1226, roughness: 0.6 }));
      pad.userData.rideSeat = id; anchor.add(pad);
      seatList.push({ id, cartIdx: idx, side, anchor, pad, occupied: false });
    }
    carts.push({ cart, front, idx });
  }

  let ready = false;
  (async () => {
    const [front, cartModel] = await Promise.all([loadGLB('nostrich_roller_front.glb'), loadGLB('nostrich_roller_cart.glb')]);
    const usedGlb = front || cartModel;
    if (usedGlb) {
      // Fit a cart to ~1.4 m and DERIVE the seat offsets from its real bounds (side-by-side pair).
      const probe = (cartModel || front).clone(true); const sc = fitToHeight(probe, 1.4); const { size, center } = measure(probe);
      seatDX = Math.max(0.22, size.x * 0.26); seatY = center.y + size.y * 0.18; seatZ = center.z;
      console.log(`[coaster] cart GLB fit scale ${sc.toFixed(3)} · bounds ${size.x.toFixed(2)}×${size.y.toFixed(2)}×${size.z.toFixed(2)}m → seat ±${seatDX.toFixed(2)}x ${seatY.toFixed(2)}y ${seatZ.toFixed(2)}z`);
    } else console.warn('[coaster] GLBs absent — primitive placeholder carts + ±0.34 seats');
    if (front) fitToHeight(front, 1.4);
    buildCart(front, true, 0);
    for (let i = 1; i < nCarts; i++) { const m = cartModel ? cartModel.clone(true) : null; if (m) fitToHeight(m, 1.4); buildCart(m, false, i); }
    ready = true; layoutTrain();
  })();

  // ── Ride state ──
  let mode = 'idle', u = 0, boardT = 0;
  drawPost();   // initial "RIDE ⚡210" (mode is now defined)

  function layoutTrain() {
    for (const c of carts) {
      poseAt((u - c.idx * CART_GAP + 1) % 1, c.cart.position, c.cart.quaternion); // continuous PT frame (slerp)
    }
  }
  function update(dt) {
    if (!ready) return;
    if (mode === 'boarding') { boardT -= dt; if (boardT <= 0) { mode = 'running'; onDepart && onDepart(); } }
    else if (mode === 'running') {
      const slope = T[idxAt(u)].y;                                   // -1..1
      const f = THREE.MathUtils.clamp(1 - slope * SLOPE_K, SPEED_MIN, SPEED_MAX); // gravity coupling
      u += (1 / RUN_S) * f * dt;
      if (u >= 1) { u = 0; mode = 'idle'; onReturn && onReturn(); }
    }
    drawPost();       // refresh the RIDE post label (idle ⚡210 / departs Ns / riding — only on change)
    layoutTrain();
  }

  // ── Build-time self-check (4.12): report clearance / heights / speeds / frame continuity ──
  {
    let maxUpDelta = 0, maxInvDelta = 0, maxY = -Infinity, minClear = Infinity;
    for (let i = 0; i <= N; i++) {
      if (i < N) {
        const d = UPB[i].angleTo(UPB[i + 1]);               // frame-to-frame up-vector step
        maxUpDelta = Math.max(maxUpDelta, d);
        if (Math.abs(T[i].y) > 0.35) maxInvDelta = Math.max(maxInvDelta, d); // steep = the inversion loop
      }
      maxY = Math.max(maxY, P[i].y);
      const inFootprint = Math.hypot(P[i].x - STAGE_POS.x, P[i].z - STAGE_POS.z) < FOOTPRINT_R;
      if (inFootprint) minClear = Math.min(minClear, P[i].y - TICKER_TOP);
    }
    let loopT = 0; for (let i = 0; i < N; i++) { const f = THREE.MathUtils.clamp(1 - T[i].y * SLOPE_K, SPEED_MIN, SPEED_MAX); loopT += (1 / N) / ((1 / RUN_S) * f); }
    console.log(`[coaster] len ${LEN.toFixed(0)}m · maxHeight ${maxY.toFixed(1)}m · clearance over ticker(${TICKER_TOP.toFixed(1)}m) +${minClear.toFixed(1)}m · speed ${(SPEED_MIN * LEN / RUN_S).toFixed(1)}–${(SPEED_MAX * LEN / RUN_S).toFixed(1)} m/s · loop ~${loopT.toFixed(0)}s · max frame up-Δ ${THREE.MathUtils.radToDeg(maxUpDelta).toFixed(2)}° (thru inversion ${THREE.MathUtils.radToDeg(maxInvDelta).toFixed(2)}°)`);
  }

  const seatById = (id) => seatList.find((s) => s.id === id);
  return {
    group, update,
    get ready() { return ready; },
    seats: () => seatList,
    seatPads: () => seatList.map((s) => s.pad).filter(Boolean),
    occupy: (id, on) => { const s = seatById(id); if (s) s.occupied = on; },
    isOccupied: (id) => !!seatById(id)?.occupied,
    seatAnchor: (id) => seatById(id)?.anchor || null,           // rig inherits THIS world quaternion
    seatWorldPos: (id, out) => { const a = seatById(id)?.anchor; if (a) a.getWorldPosition(out); return out; },
    state: () => mode,
    boardable: () => mode === 'idle',
    beginBoarding: () => { if (mode === 'idle') { mode = 'boarding'; boardT = DEPART_S; } },
    countdown: () => (mode === 'boarding' ? Math.ceil(boardT) : 0),
    trainU: () => u,
    rideButton: () => postLabel,                                // the pickable RIDE post (4.13 #5)
    nextFreeSeat: () => seatList.find((s) => !s.occupied)?.id || null, // seat-snap target on select
    dispose() { scene.remove(group); },
  };
}

function postRoundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r);
  g.closePath();
}
