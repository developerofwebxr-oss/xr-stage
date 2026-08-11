import * as THREE from 'three';
import { STAGE_POS } from '../room/zones.js';

// zones/zones.js — the SOCIAL zones as ENCLOSED destination buildings across the plaza
// behind the audience, plus the detection SEAM later slices consume. Facades + shells only;
// interiors are dark, texture-ready, and empty until the decoration/prop slice.
//
// NB: distinct from room/zones.js (stage LAYOUT + movement clamp). Here:
//   • Networking — a curved-facade HALL, fully enclosed (side + back walls + ceiling), so the
//     plaza sees only the facade + a dark doorway; inside is a real room.
//   • Smoking — a park GATE opening into an enclosed CLEARING (hedge perimeter + dense trees),
//     so the plaza sees only the gate opening; trees recede to the horizon as backdrop.
//
//   zones.current()        → the zone the local rig is in, or null
//   zones.onChange(cb)     → subscribe to enter/leave; returns unsub  (cb(zone|null))
//   zones.update(x, z)     → recompute from the rig's XZ; emits only when the zone changes
//   buildZoneScenery(scene)→ adds the buildings/gate/clearing/trees/plaques (call once)
//   zoneAnchors            → named refs into each interior for the future decoration slice
//
// ─── AUDIO-EXCLUSIVITY SEAM (later slice — do NOT wire here) ────────────────────────────
// The enter/leave events from `zones.onChange` are the hook the AUDIO-ZONE slice will use to
// drive audio ISOLATION: while inside a zone, occupants hear each other but NOT the plaza,
// and the plaza does NOT hear them (and vice versa) — e.g. by moving the participant to a
// per-zone LiveKit audio group / muting cross-zone tracks on enter, restoring on leave. This
// module stays presentation-only; nothing here touches voice/LiveKit.
// ────────────────────────────────────────────────────────────────────────────────────────

const EMBER = 0xff6a2c;   // Smoking — warm ember
const TEAL  = 0x27c6c6;   // Networking — cool teal
const C = STAGE_POS;      // arc centre = stage centre (0,0,−7)

const onArc = (radius, a) => new THREE.Vector3(C.x + radius * Math.sin(a), 0, C.z + radius * Math.cos(a));
const bearing = (x, z) => Math.atan2(x - C.x, z - C.z);
const radiusOf = (x, z) => Math.hypot(x - C.x, z - C.z);

export const ZONE_DEFS = [
  {
    id: 'smoking', name: 'Smoking Area', emoji: '🚬', hue: EMBER,
    fx: -13, fz: 19,             // park gate, back-left
    cx: -14.1, cz: 21.2, r: 3.2, // detection: inside the clearing (past the gate)
    requires: 'smokingAccess', accessKind: 'smoking', // ticket flag / micro-purchase kind for the door
    lettersText: 'SMOKING AREA', lettersH: 2.0,
    plaque: 'Permissionless talk. The closer you stand, the better you hear. Entry: ticket + mic permission — your mic is ON in here.',
  },
  {
    id: 'networking', name: 'Networking', emoji: '🤝', hue: TEAL,
    fx: 6, fz: 24,               // hall doorway, back centre/right
    cx: 6.48, cz: 26.46, r: 3.4, // detection: inside the hall
    requires: 'networkingAccess', accessKind: 'networking',
    lettersText: 'NETWORKING', lettersH: 2.6,
    plaque: 'Meet people. Ask to talk — mic by mutual permission. Entry with ticket.',
  },
];

// ── Detection seam (API unchanged — only the bounds/enclosure moved) ────────────────
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

// Zone-entry ACCESS gate (wired to ticket flags in main). If (x,z) is inside a zone the
// player may not enter, softly push them to JUST outside that zone's boundary and report it
// — a gentle wall at the door, no hard teleport. `allow(zn)` → may this player enter zn?
const EDGE = 0.15;
export function accessClamp(x, z, allow) {
  for (const zn of ZONE_DEFS) {
    const dx = x - zn.cx, dz = z - zn.cz;
    const d2 = dx * dx + dz * dz;
    if (d2 <= zn.r * zn.r && !allow(zn)) {
      const d = Math.sqrt(d2) || 1e-6;
      const k = (zn.r + EDGE) / d;                 // push out to just past the boundary
      return { x: zn.cx + dx * k, z: zn.cz + dz * k, blocked: zn };
    }
  }
  return { x, z, blocked: null };
}

export const zones = {
  current() { return _current; },
  onChange(cb) { _subs.add(cb); return () => _subs.delete(cb); },
  update(x, z) {
    if (x === _lastX && z === _lastZ) return _current; // rig didn't move → nothing to do
    _lastX = x; _lastZ = z;
    const next = zoneAt(x, z);
    if (next !== _current) {
      _current = next;
      for (const cb of _subs) cb(_current);
    }
    return _current;
  },
};

// ── Decoration seam ─────────────────────────────────────────────────────────────────
// Named references INTO each enclosed interior, so a later slice (or the owner's generated
// wall textures / GLB props: tables, sofas, cigar bar, benches) can attach without hunting
// the scene graph. Populated by buildZoneScenery(). Shapes:
//   zoneAnchors.networking = { walls:[back,left,right], floor, ceiling, propSpawns:[Object3D…] }
//   zoneAnchors.smoking    = { ground, perimeter:[back,left,right,frontL,frontR], propSpawns:[…] }
// `propSpawns` are empty Object3D transforms parked at interior spots (world-correct via their
// parent group) — read `.matrixWorld` / parent them to drop furniture at the right place.
export const zoneAnchors = { networking: null, smoking: null };

// ── Shared materials (cheap: a handful, reused; emissive-via-MeshBasic, no lights/shadows,
// fog-aware; interior surfaces are flat dark TEXTURE-READY canvases) ─────────────────────
const M = {
  wall:     new THREE.MeshBasicMaterial({ color: 0x0b111c, side: THREE.DoubleSide }), // facade
  interior: new THREE.MeshBasicMaterial({ color: 0x0a0e16, side: THREE.DoubleSide }), // hall walls/ceiling
  floorNet: new THREE.MeshBasicMaterial({ color: 0x0a1218, side: THREE.DoubleSide }), // hall floor
  hedge:    new THREE.MeshBasicMaterial({ color: 0x0a1108, side: THREE.DoubleSide }), // clearing perimeter
  groundSmk:new THREE.MeshBasicMaterial({ color: 0x100b07, side: THREE.DoubleSide }), // clearing ground
  post:     new THREE.MeshBasicMaterial({ color: 0x11151f }),
  teal:     new THREE.MeshBasicMaterial({ color: TEAL, transparent: true, opacity: 0.9 }),
  ember:    new THREE.MeshBasicMaterial({ color: EMBER, transparent: true, opacity: 0.9 }),
  tree:     new THREE.MeshBasicMaterial({ color: 0x231206 }), // dark ember-tinted silhouette
};

const plane = (w, h, mat) => new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
const hedge = (w, h) => new THREE.Mesh(new THREE.PlaneGeometry(w, h), M.hedge);
// A group on the arc at (radius, angle): local +Z points OUTWARD (deeper), +X tangent.
function radialGroup(radius, a) {
  const g = new THREE.Group();
  g.position.copy(onArc(radius, a));
  g.rotation.y = a;
  return g;
}
// An empty prop-spawn transform at interior-local (x,z), added to `group` and named.
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
  group.add(net.group, smk.group);
  zoneAnchors.networking = net.anchors;
  zoneAnchors.smoking = smk.anchors;
  scene.add(group);
  return group;
}

// NETWORKING — curved front facade with a doorway, fully enclosed by side + back walls and a
// ceiling → from the plaza you see only the facade and a dark doorway; nothing inside.
function buildNetworking(zn) {
  const g = new THREE.Group();
  const R = radiusOf(zn.fx, zn.fz);
  const th = bearing(zn.fx, zn.fz);
  const H = 5.4;                    // wall/ceiling height (generous — people + future furniture)
  const wallHalf = 0.22, doorHalf = 0.055;
  const D = 9;                      // INTERIOR_DEPTH — SEAM: occupancy scales this later; static now
  const HW = R * Math.sin(wallHalf) + 0.05; // interior half-width ≈ facade half-chord (~6.9)

  // Curved dark facade: two wall arcs flanking the doorway + teal lintel + door jambs.
  g.add(arcWall(R, H, th - wallHalf, wallHalf - doorHalf, M.wall));
  g.add(arcWall(R, H, th + doorHalf, wallHalf - doorHalf, M.wall));
  g.add(arcWall(R + 0.02, 0.22, th - wallHalf, wallHalf * 2, M.teal, { y: H - 0.11 }));
  for (const s of [-1, 1]) {
    const jamb = new THREE.Mesh(new THREE.BoxGeometry(0.12, H, 0.12), M.teal);
    jamb.position.copy(onArc(R, th + s * doorHalf)); jamb.position.y = H / 2; jamb.rotation.y = th + s * doorHalf;
    g.add(jamb);
  }

  // Enclosure — clean dark texture-ready planes. Planes span local z ∈ [−1, D] so their front
  // edge tucks behind the (slightly bowed) facade ends → no corner gaps to see through.
  const room = radialGroup(R, th);
  const zc = (D - 1) / 2;
  const floor = plane(2 * HW, D + 1, M.floorNet);  floor.rotation.x = -Math.PI / 2; floor.position.set(0, 0.02, zc);
  const ceiling = plane(2 * HW, D + 1, M.interior); ceiling.rotation.x = Math.PI / 2; ceiling.position.set(0, H, zc);
  const back = plane(2 * HW, H, M.interior);        back.position.set(0, H / 2, D);
  const left = plane(D + 1, H, M.interior);         left.rotation.y = Math.PI / 2;  left.position.set(-HW, H / 2, zc);
  const right = plane(D + 1, H, M.interior);        right.rotation.y = -Math.PI / 2; right.position.set(HW, H / 2, zc);
  room.add(floor, ceiling, back, left, right);
  const propSpawns = [
    addAnchor(room, 0, 3.5, 'net-centre'),
    addAnchor(room, -4, 5, 'net-sofa-L'),
    addAnchor(room, 4, 5, 'net-sofa-R'),
    addAnchor(room, 0, 7.5, 'net-back'),
  ];
  g.add(room);

  g.add(placeLetters(zn, R + 0.1, th, H + 1.3));          // wayfinding name above the facade
  g.add(placePlaque(zn, R, th + wallHalf + 0.06));        // plaque beside the entrance

  return { group: g, anchors: { walls: [back, left, right], floor, ceiling, propSpawns } };
}

// SMOKING — a park gate opening into an ENCLOSED clearing: distinct ground + a closed hedge
// perimeter (back + sides + gate-flanking fronts) so the plaza sees only the gate opening;
// dense trees screen + a receding treeline forms the horizon backdrop.
function buildSmoking(zn) {
  const g = new THREE.Group();
  const R = radiusOf(zn.fx, zn.fz);
  const th = bearing(zn.fx, zn.fz);
  const postH = 3.6, gateHalf = 0.07;
  const CW = 11, CD = 10, HH = 3.0; // clearing width/depth, hedge height

  // Gate: posts + ember caps + arch beam + sign frame.
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

  // Enclosed clearing: distinct ground + closed hedge perimeter (only the gate opening is a gap).
  const yard = radialGroup(R, th);
  const gapHalf = R * Math.sin(gateHalf) + 0.2;   // half the gate opening, local x (~2.2)
  const zc = CD / 2;
  const ground = plane(CW, CD, M.groundSmk); ground.rotation.x = -Math.PI / 2; ground.position.set(0, 0.02, zc);
  const back = hedge(CW, HH); back.position.set(0, HH / 2, CD);
  const leftH = hedge(CD, HH); leftH.rotation.y = Math.PI / 2; leftH.position.set(-CW / 2, HH / 2, zc);
  const rightH = hedge(CD, HH); rightH.rotation.y = -Math.PI / 2; rightH.position.set(CW / 2, HH / 2, zc);
  const frontW = CW / 2 - gapHalf;                // width of each gate-flanking front hedge
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
  g.add(buildTreeline(R, th));                    // dense screen around the clearing + horizon backdrop
  g.add(placePlaque(zn, R, th + gateHalf + 0.12));

  return { group: g, anchors: { ground, perimeter: [back, leftH, rightH, frontL, frontR], propSpawns } };
}

// A curved wall arc = an open-ended cylinder segment centred on the stage. `opt.y` overrides
// the vertical centre (thin lintel trim).
function arcWall(radius, height, thetaStart, thetaLength, mat, opt = {}) {
  const segs = Math.max(6, Math.round((thetaLength / (Math.PI * 2)) * 220));
  const geo = new THREE.CylinderGeometry(radius, radius, height, segs, 1, true, thetaStart, thetaLength);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(C.x, opt.y ?? height / 2, C.z);
  return mesh;
}

// A dense tree screen wrapping the clearing (closes any hedge gaps to the eye) plus rows
// receding to the horizon as backdrop. One InstancedMesh; deterministic; fog fades the far
// ones. Trees start BEHIND the gate line so they never block the gate opening.
function buildTreeline(R, th) {
  const RINGS = 7, COLS = 9, N = RINGS * COLS;
  const inst = new THREE.InstancedMesh(new THREE.ConeGeometry(0.6, 2.6, 7), M.tree, N);
  inst.frustumCulled = false;
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3();
  const hash = (i) => { const x = Math.sin(i * 12.9898) * 43758.5453; return x - Math.floor(x); };
  let i = 0;
  for (let ring = 0; ring < RINGS; ring++) {
    for (let col = 0; col < COLS; col++) {
      const h1 = hash(i * 2 + 1), h2 = hash(i * 2 + 7);
      const rr = R + 1.8 + ring * 2.1 + (h1 - 0.5) * 1.1;      // deeper each ring
      const spread = 0.12 + ring * 0.02;                       // fan wider → wraps the sides, then recedes
      const aa = th + (col - (COLS - 1) / 2) * spread + (h2 - 0.5) * 0.03;
      const scale = 1.15 + h1 * 0.8;
      const pos = onArc(rr, aa);
      p.set(pos.x, 1.3 * scale, pos.z);
      inst.setMatrixAt(i, m.compose(p, q, s.set(scale, scale, scale)));
      i++;
    }
  }
  inst.instanceMatrix.needsUpdate = true;
  return inst;
}

// ── Letters + plaque (canvas textures, built once) ──────────────────────────────────
function placeLetters(zn, radius, a, y) {
  const g = radialGroup(radius, a);
  const mesh = makeLettersPlane(zn.lettersText, zn.hue, zn.lettersH);
  mesh.position.y = y; mesh.rotation.y = Math.PI; // face inward toward the stage/audience
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

function placePlaque(zn, radius, a) {
  const g = radialGroup(radius, a);
  const postH = 1.02, panelW = 1.5, panelH = 0.92;
  const post = new THREE.Mesh(new THREE.BoxGeometry(0.09, postH, 0.09), M.post);
  post.position.y = postH / 2; g.add(post);
  const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.3, 0.06, 20), M.post);
  foot.position.y = 0.03; g.add(foot);
  const panel = makePlaquePanel(zn, panelW, panelH);
  panel.position.set(0, postH + panelH / 2 - 0.04, 0);
  panel.rotation.y = Math.PI; panel.rotateX(0.16); // face inward, tilt up toward the reader
  g.add(panel);
  return g;
}

function makePlaquePanel(zn, worldW, worldH) {
  const CW = 620, CH = Math.round(CW * (worldH / worldW));
  const cv = document.createElement('canvas');
  cv.width = CW; cv.height = CH;
  const ctx = cv.getContext('2d');
  const hex = `#${new THREE.Color(zn.hue).getHexString()}`;
  roundRect(ctx, 3, 3, CW - 6, CH - 6, 20);
  ctx.fillStyle = '#0c111b'; ctx.fill();
  ctx.strokeStyle = hex; ctx.lineWidth = 3; ctx.globalAlpha = 0.8; ctx.stroke(); ctx.globalAlpha = 1;
  ctx.textBaseline = 'alphabetic'; ctx.fillStyle = hex;
  ctx.font = '700 40px ui-monospace, "SF Mono", Menlo, monospace';
  ctx.fillText(`${zn.emoji} ${zn.name}`, 34, 66);
  ctx.fillStyle = 'rgba(236,238,245,0.9)';
  ctx.font = '400 30px system-ui, -apple-system, sans-serif';
  wrapText(ctx, zn.plaque, 34, 116, CW - 68, 40);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
  return new THREE.Mesh(new THREE.PlaneGeometry(worldW, worldH), new THREE.MeshBasicMaterial({ map: tex }));
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
