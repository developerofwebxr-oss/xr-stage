import * as THREE from 'three';

// zones/zones.js — the SOCIAL zones behind the audience (Smoking Area + Networking) as
// visible, named places, plus the detection SEAM the ticketing/audio slices will consume.
//
// NB: this is distinct from room/zones.js, which owns the stage LAYOUT + movement clamp.
// Here we only add cosmetic landmarks (floor tint, big glowing letters, a plaque stand) and
// a cheap point-in-zone test that emits enter/leave for the local player:
//
//   zones.current()        → the zone the local rig is in, or null
//   zones.onChange(cb)     → subscribe to enter/leave; returns unsub  (cb(zone|null))
//   zones.update(x, z)     → recompute from the rig's XZ; emits only when the zone changes
//   buildZoneScenery(scene)→ adds the floor markings + signage + plaques (call once)
//
// Placement is authored for a player standing on the audience floor FACING the stage
// (stage at -Z, so "behind you" is +Z; "left" is -X). Circles are cheap and read as open
// areas. No entry gating, no mic/audio, no props-on-people yet — that's later slices; this
// module just draws the places and fires the seam.

const EMBER = 0xff6a2c;   // Smoking Area — warm ember
const TEAL  = 0x27c6c6;   // Networking  — cool teal (distinct from the venue orange)

// Each zone: a circle on the floor (metres, world space). Networking is noticeably larger
// and sits deepest ("opposite the stage"); Smoking is back-left and smaller.
export const ZONE_DEFS = [
  {
    id: 'smoking', name: 'Smoking Area', emoji: '🚬', hue: EMBER,
    cx: -7.5, cz: 9, r: 3,
    lettersY: 2.6, lettersSize: 1, lettersText: 'SMOKING AREA',
    plaque: 'Permissionless talk. The closer you stand, the better you hear. Entry: ticket + mic permission — your mic is ON in here. Every smoker gets a lit cigarette. 🚬',
  },
  {
    id: 'networking', name: 'Networking', emoji: '🤝', hue: TEAL,
    cx: 3, cz: 11.5, r: 4.5,
    lettersY: 3.2, lettersSize: 1.35, lettersText: 'NETWORKING',
    plaque: 'Meet people. Ask to talk — mic by mutual permission. Entry with ticket.',
  },
];

// ── Detection seam ────────────────────────────────────────────────────────────────
const _subs = new Set();
let _current = null;        // zone object | null
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

  // Recompute the local player's zone from the rig XZ. Cheap (a couple of squared-distance
  // checks) and only does work when the rig actually moved; emits ONLY on an enter/leave.
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

// ── Scenery (cosmetic, built once — no per-frame work) ──────────────────────────────
// All emissive-via-MeshBasic (no lights, no shadow maps): floor tint disc + edge-glow ring,
// big glowing name letters (canvas plane) standing over the zone, and a plaque on a short
// stand at the entrance edge. Freestanding props → they remain visible in AR (they are not
// part of the room shell that AR hides).
export function buildZoneScenery(scene) {
  const group = new THREE.Group();
  group.name = 'zoneScenery';
  for (const zn of ZONE_DEFS) group.add(buildZone(zn));
  scene.add(group);
  return group;
}

function buildZone(zn) {
  const g = new THREE.Group();
  g.position.set(zn.cx, 0, zn.cz);
  const col = new THREE.Color(zn.hue);

  // Floor tint — a translucent disc marking the area…
  const fill = new THREE.Mesh(
    new THREE.CircleGeometry(zn.r, 64),
    new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.1, depthWrite: false }),
  );
  fill.rotation.x = -Math.PI / 2;
  fill.position.y = 0.02;
  fill.renderOrder = 1; // over the base floor, under avatars/props
  g.add(fill);

  // …with a brighter edge-glow ring at its bound.
  const edge = new THREE.Mesh(
    new THREE.RingGeometry(zn.r - 0.18, zn.r, 96, 1),
    new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide }),
  );
  edge.rotation.x = -Math.PI / 2;
  edge.position.y = 0.03;
  edge.renderOrder = 1;
  g.add(edge);

  // Big glowing name letters — standing landmark near the back of the zone, FACING the
  // audience/spawn (-Z). rotation.y = π turns the textured face toward the player (a rigid
  // turn, so the text stays upright/un-mirrored), like turning a sign around.
  const letters = makeLettersPlane(zn.lettersText, col, zn.lettersSize);
  letters.position.set(0, zn.lettersY, zn.r * 0.55);
  letters.rotation.y = Math.PI;
  g.add(letters);

  // Description plaque on a short stand at the ENTRANCE edge (front, toward the spawn),
  // facing the approaching player. Solid panel (opaque backdrop, per the 3.11 rules).
  const stand = buildPlaqueStand(zn, col);
  stand.position.set(0, 0, -zn.r + 0.1);
  stand.rotation.y = Math.PI;
  g.add(stand);

  return g;
}

// A canvas-textured plane of glowing letters (transparent bg → reads as floating letters).
function makeLettersPlane(text, color, scale) {
  const pad = 40, fontPx = 150;
  const cv = document.createElement('canvas');
  const g = cv.getContext('2d');
  g.font = `800 ${fontPx}px ui-monospace, "SF Mono", Menlo, monospace`;
  const w = Math.ceil(g.measureText(text).width) + pad * 2;
  const h = fontPx + pad * 2;
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d');
  ctx.font = `800 ${fontPx}px ui-monospace, "SF Mono", Menlo, monospace`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const hex = `#${new THREE.Color(color).getHexString()}`;
  // glow halo + solid core
  ctx.shadowColor = hex; ctx.shadowBlur = 46;
  ctx.fillStyle = hex;
  ctx.fillText(text, w / 2, h / 2);
  ctx.shadowBlur = 0;
  ctx.fillStyle = '#fff6ec';                 // hot core keeps letters legible over the glow
  ctx.globalAlpha = 0.9;
  ctx.fillText(text, w / 2, h / 2);
  ctx.globalAlpha = 1;

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const worldH = 0.62 * scale;               // metres tall
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry((w / h) * worldH, worldH),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }),
  );
  mesh.renderOrder = 3;
  return mesh;
}

// A short post + an angled solid plaque panel (same card technique as the boards).
function buildPlaqueStand(zn, color) {
  const g = new THREE.Group();
  const postH = 1.02, panelW = 1.5, panelH = 0.92;

  const postMat = new THREE.MeshBasicMaterial({ color: 0x11151f });
  const post = new THREE.Mesh(new THREE.BoxGeometry(0.09, postH, 0.09), postMat);
  post.position.y = postH / 2;
  g.add(post);
  const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.3, 0.06, 24), postMat);
  foot.position.y = 0.03;
  g.add(foot);

  const panel = makePlaquePanel(zn, color, panelW, panelH);
  panel.position.set(0, postH + panelH / 2 - 0.04, 0.02);
  panel.rotation.x = -0.16;              // tilt up slightly toward the reader
  g.add(panel);
  return g;
}

// One SOLID plaque: opaque backdrop (writes depth so it occludes cleanly at any angle — the
// 3.11 rule) + hue frame + title + wrapped body, all baked to a canvas once.
function makePlaquePanel(zn, color, worldW, worldH) {
  const CW = 620, CH = Math.round(CW * (worldH / worldW));
  const cv = document.createElement('canvas');
  cv.width = CW; cv.height = CH;
  const ctx = cv.getContext('2d');
  const hex = `#${new THREE.Color(color).getHexString()}`;

  roundRect(ctx, 3, 3, CW - 6, CH - 6, 20);
  ctx.fillStyle = '#0c111b'; ctx.fill();               // opaque
  ctx.strokeStyle = hex; ctx.lineWidth = 3; ctx.globalAlpha = 0.8; ctx.stroke(); ctx.globalAlpha = 1;

  // Title (emoji + name), in the zone hue.
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = hex;
  ctx.font = '700 40px ui-monospace, "SF Mono", Menlo, monospace';
  ctx.fillText(`${zn.emoji} ${zn.name}`, 34, 66);

  // Body — wrapped, soft ink.
  ctx.fillStyle = 'rgba(236,238,245,0.9)';
  ctx.font = '400 30px system-ui, -apple-system, sans-serif';
  wrapText(ctx, zn.plaque, 34, 116, CW - 68, 40);

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(worldW, worldH),
    new THREE.MeshBasicMaterial({ map: tex }),          // opaque (transparent:false, depthWrite:true)
  );
  return mesh;
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
