import * as THREE from 'three';
import { STAGE_POS } from '../room/zones.js';

// zones/zones.js — the SOCIAL zones as DISTANT DESTINATION BUILDINGS across the plaza behind
// the audience (a real courtyard walk from the stage), plus the detection SEAM the ticketing/
// audio slices will consume. Facades + shells only — interiors are a later slice.
//
// NB: distinct from room/zones.js (stage LAYOUT + movement clamp). Here we add diegetic
// props — a curved Networking hall with a doorway, a Smoking park-gate + treeline — and a
// cheap point-in-zone test whose bound is now "inside the building / past the gate":
//
//   zones.current()        → the zone the local rig is in, or null
//   zones.onChange(cb)     → subscribe to enter/leave; returns unsub  (cb(zone|null))
//   zones.update(x, z)     → recompute from the rig's XZ; emits only when the zone changes
//   buildZoneScenery(scene)→ adds the buildings/gate/trees/plaques (call once)
//
// Placement is authored for a player on the audience floor FACING the stage (stage at −Z, so
// "behind" is +Z, "left" is −X). The facades are ARCS concentric with the stage (same centre
// as the radiating floor rings), so the buildings sit on the venue's own geometry.

const EMBER = 0xff6a2c;   // Smoking — warm ember
const TEAL  = 0x27c6c6;   // Networking — cool teal
const C = STAGE_POS;      // arc centre = stage centre (0,0,−7)

// A point on the arc of `radius` at bearing `a` (three's cylinder convention: x=R·sinθ,
// z=R·cosθ, θ from +Z toward +X), in WORLD space.
const onArc = (radius, a) => new THREE.Vector3(C.x + radius * Math.sin(a), 0, C.z + radius * Math.cos(a));
const bearing = (x, z) => Math.atan2(x - C.x, z - C.z);
const radiusOf = (x, z) => Math.hypot(x - C.x, z - C.z);

// Each zone: an ENTRANCE front-centre point (fx,fz) on its arc, and a DETECTION circle sitting
// just inside (past the door/gate) so the HUD pill fires on actually entering. Networking is
// the deeper, larger destination.
export const ZONE_DEFS = [
  {
    id: 'smoking', name: 'Smoking Area', emoji: '🚬', hue: EMBER,
    fx: -13, fz: 19,            // park gate, back-left
    cx: -14.1, cz: 21.2, r: 3.2, // detection: past the gate
    lettersText: 'SMOKING AREA', lettersH: 2.0,
    plaque: 'Permissionless talk. The closer you stand, the better you hear. Entry: ticket + mic permission — your mic is ON in here. Every smoker gets a lit cigarette. 🚬',
  },
  {
    id: 'networking', name: 'Networking', emoji: '🤝', hue: TEAL,
    fx: 6, fz: 24,             // hall doorway, back centre/right ("opposite the stage")
    cx: 6.48, cz: 26.46, r: 3.4, // detection: inside the hall
    lettersText: 'NETWORKING', lettersH: 2.6,
    plaque: 'Meet people. Ask to talk — mic by mutual permission. Entry with ticket.',
  },
];

// ── Detection seam (API unchanged from 3.13 — only the bounds moved) ────────────────
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

// ── Shared materials (cheap: a handful, reused across all meshes; emissive-via-MeshBasic,
// no lights, no shadows, fog-aware so distance fades to the sky for free) ────────────────
const M = {
  wall:  new THREE.MeshBasicMaterial({ color: 0x0b111c, side: THREE.DoubleSide }), // dark building shell
  floorDark: new THREE.MeshBasicMaterial({ color: 0x05080e, side: THREE.DoubleSide, transparent: true, opacity: 0.92 }),
  post:  new THREE.MeshBasicMaterial({ color: 0x11151f }),
  teal:  new THREE.MeshBasicMaterial({ color: TEAL, transparent: true, opacity: 0.9 }),  // emissive trim
  ember: new THREE.MeshBasicMaterial({ color: EMBER, transparent: true, opacity: 0.9 }),
  tealLine: new THREE.MeshBasicMaterial({ color: TEAL, transparent: true, opacity: 0.5, depthWrite: false }),
  tree:  new THREE.MeshBasicMaterial({ color: 0x231206 }), // dark ember-tinted silhouette (fog fades depth)
};
const trimMat = (hue) => (hue === TEAL ? M.teal : M.ember);

// ── Scenery ─────────────────────────────────────────────────────────────────────────
export function buildZoneScenery(scene) {
  const group = new THREE.Group();
  group.name = 'zoneScenery';
  group.add(buildNetworking(ZONE_DEFS[1]));
  group.add(buildSmoking(ZONE_DEFS[0]));
  scene.add(group);
  return group;
}

// A group anchored on the arc at (radius, angle) with local +Z pointing OUTWARD (deeper into
// the building) and +X tangent — so children can be authored in simple local space.
function radialGroup(radius, a) {
  const g = new THREE.Group();
  g.position.copy(onArc(radius, a));
  g.rotation.y = a;
  return g;
}

// NETWORKING — a tall curved front wall (arc concentric with the stage) with a doorway gap,
// a teal lintel trim, big letters above, and a simple deep shell receding into the dark.
function buildNetworking(zn) {
  const g = new THREE.Group();
  const R = radiusOf(zn.fx, zn.fz);       // facade radius (fits its position on the venue arc)
  const th = bearing(zn.fx, zn.fz);
  const H = 5.4;                          // wall height
  const wallHalf = 0.22;                  // arc half-width (each side of centre)
  const doorHalf = 0.055;                 // doorway half-width (a walk-through gap)
  const INTERIOR_DEPTH = 9;               // shell length — SEAM: occupancy scales this later (10 vs 300 ppl); static now

  // Two dark wall arcs flanking the doorway (openEnded cylinder segments = curved walls).
  g.add(arcWall(R, H, th - wallHalf, wallHalf - doorHalf, M.wall));
  g.add(arcWall(R, H, th + doorHalf,  wallHalf - doorHalf, M.wall));
  // Teal lintel trim across the full span (bridges the doorway top) + door-jamb glow strips.
  g.add(arcWall(R + 0.02, 0.22, th - wallHalf, wallHalf * 2, M.teal, { y: H - 0.11 }));
  for (const s of [-1, 1]) {
    const jamb = new THREE.Mesh(new THREE.BoxGeometry(0.12, H, 0.12), M.teal);
    jamb.position.copy(onArc(R, th + s * doorHalf)); jamb.position.y = H / 2; jamb.rotation.y = th + s * doorHalf;
    g.add(jamb);
  }

  // Deep shell behind the doorway: dark floor + back wall (fog fades it) + two receding teal
  // edge-glow lines suggesting depth. All authored in a radial group (local +Z = outward).
  const shell = radialGroup(R, th);
  const arcW = 2 * wallHalf * R;                        // interior width ≈ facade width
  const floorPln = new THREE.Mesh(new THREE.PlaneGeometry(arcW, INTERIOR_DEPTH), M.floorDark);
  floorPln.rotation.x = -Math.PI / 2; floorPln.position.set(0, 0.02, INTERIOR_DEPTH / 2);
  shell.add(floorPln);
  const back = new THREE.Mesh(new THREE.PlaneGeometry(arcW, H), M.wall);
  back.position.set(0, H / 2, INTERIOR_DEPTH); shell.add(back);
  for (const s of [-1, 1]) {
    const line = new THREE.Mesh(new THREE.PlaneGeometry(0.08, INTERIOR_DEPTH), M.tealLine);
    line.rotation.x = -Math.PI / 2; line.position.set(s * (arcW / 2 - 0.2), 0.04, INTERIOR_DEPTH / 2);
    shell.add(line);
  }
  g.add(shell);

  // Big wayfinding letters above the doorway, facing the audience (inward).
  g.add(placeLetters(zn, R + 0.1, th, H + 1.3));
  // Plaque beside the entrance.
  g.add(placePlaque(zn, R, th + wallHalf + 0.06));
  return g;
}

// SMOKING — a park gate (two posts + arch beam), the name over the arch, and a receding
// treeline screening the (empty for now) interior.
function buildSmoking(zn) {
  const g = new THREE.Group();
  const R = radiusOf(zn.fx, zn.fz);
  const th = bearing(zn.fx, zn.fz);
  const postH = 3.6, gateHalf = 0.07;     // ~4 m opening

  for (const s of [-1, 1]) {
    const a = th + s * gateHalf;
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.36, postH, 0.36), M.post);
    post.position.copy(onArc(R, a)); post.position.y = postH / 2; post.rotation.y = a;
    g.add(post);
    const cap = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.12, 0.5), M.ember);
    cap.position.copy(onArc(R, a)); cap.position.y = postH; cap.rotation.y = a;
    g.add(cap);
  }
  // Arch beam across the top + an ember sign frame the letters sit over.
  const beamG = radialGroup(R, th);
  const beamW = 2 * gateHalf * R + 0.8;
  const beam = new THREE.Mesh(new THREE.BoxGeometry(beamW, 0.34, 0.3), M.post);
  beam.position.y = postH + 0.05; beamG.add(beam);
  const frame = new THREE.Mesh(new THREE.BoxGeometry(beamW, 0.08, 0.34), M.ember);
  frame.position.y = postH + 0.24; beamG.add(frame);
  g.add(beamG);

  // Name over the arch, facing the audience.
  g.add(placeLetters(zn, R + 0.05, th, postH + 1.15));
  // Treeline screening the interior (instanced, one draw call).
  g.add(buildTreeline(R, th));
  // Plaque beside the gate.
  g.add(placePlaque(zn, R, th + gateHalf + 0.12));
  return g;
}

// A curved wall arc = an open-ended cylinder segment centred on the stage. `opt.y` overrides
// the vertical centre (used for the thin lintel trim).
function arcWall(radius, height, thetaStart, thetaLength, mat, opt = {}) {
  const segs = Math.max(6, Math.round((thetaLength / (Math.PI * 2)) * 220));
  const geo = new THREE.CylinderGeometry(radius, radius, height, segs, 1, true, thetaStart, thetaLength);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(C.x, opt.y ?? height / 2, C.z);
  return mesh;
}

// A receding row of cheap cone "trees" fanning out behind the gate, deterministic so they
// don't jitter between loads. One InstancedMesh (shared geo+material); fog fades the far ones.
function buildTreeline(R, th) {
  const ROWS = 5, COLS = 7, N = ROWS * COLS;
  const inst = new THREE.InstancedMesh(new THREE.ConeGeometry(0.55, 2.4, 7), M.tree, N);
  inst.frustumCulled = false;
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3();
  const hash = (i) => { const x = Math.sin(i * 12.9898) * 43758.5453; return x - Math.floor(x); }; // deterministic
  let i = 0;
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const h1 = hash(i * 2 + 1), h2 = hash(i * 2 + 7);
      const rr = R + 2.2 + row * 2.3 + (h1 - 0.5) * 1.2;          // deeper each row
      const spread = 0.075 + row * 0.02;                          // fan wider with depth → a screen
      const aa = th + (col - (COLS - 1) / 2) * spread + (h2 - 0.5) * 0.03;
      const scale = 1.1 + h1 * 0.7;
      const pos = onArc(rr, aa);
      p.set(pos.x, 1.2 * scale, pos.z);
      inst.setMatrixAt(i, m.compose(p, q, s.set(scale, scale, scale)));
      i++;
    }
  }
  inst.instanceMatrix.needsUpdate = true;
  return inst;
}

// ── Letters + plaque (canvas textures, built once) ──────────────────────────────────
// Place big glowing name letters at (radius, angle), raised to `y`, facing the audience
// (inward, −Z in the radial frame → same un-mirrored trick as 3.13).
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

// A short stand + a SOLID plaque panel (opaque, per the 3.11 rules) beside the entrance,
// facing the audience.
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
