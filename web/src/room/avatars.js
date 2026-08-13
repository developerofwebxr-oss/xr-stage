import * as THREE from 'three';
import { drawKeyface } from '../identity/keyface.js';

// room/avatars.js — the bodies in the room: yours, everyone else's, and ambiance.
//
// Responsibilities, all deliberately simple so Prompt 2 can reskin them:
//   1. createPlayerBody() — YOUR body, parented to the camera rig in main.js so it
//      moves + turns with you (and so, as a speaker, the figure on stage IS you).
//   2. AvatarPool — one body per REMOTE participant, driven by presence heartbeats
//      (see state/presence.js); each smoothly tracks its reported position + yaw.
//   3. seedPlaceholders() — a few clearly-static audience capsules as ambiance,
//      kept well clear of the spawn points so none overlaps a real person.
//
// SEAM: a capsule is just a body (+ optional head). makeCapsule() and the thin
// createPlayerBody() wrapper are the single places Prompt 2 swaps in the
// deterministic "Keyface" avatar from a Nostr npub — same transforms, same pool
// API, so nothing downstream changes.

const HEAD_RADIUS = 0.22;
const BODY_CAPSULE_RADIUS = 0.28;

// Subtle self-glow on each body in its OWN colour, so an avatar always reads even in
// the dim audience floor (no per-avatar lights — cheap, scales to any crowd). Kept
// low so the lit stage still dominates. NOTE: only the BODY carries this; the head's
// flat face disc (faceMount) keeps its own non-emissive material, so the Phase-2
// Nostr profile image stays crisp/readable rather than washed out by glow.
const BODY_EMISSIVE_INTENSITY = 0.28;

// Minimum gap between two body centres for the avatar-separation system. Heads
// carry the Nostr profile pic, so heads must never intersect: keep centres at least
// a HEAD diameter + epsilon apart, and never less than a BODY diameter (if heads
// clear, bodies clear too). Single tunable knob (via GAP_EPSILON).
const GAP_EPSILON = 0.12;
export const MIN_BODY_GAP = Math.max(HEAD_RADIUS * 2, BODY_CAPSULE_RADIUS * 2) + GAP_EPSILON;

// How much of the head sphere is kept as the rounded back, expressed as the polar
// angle (from the back pole) at which the sphere is cut flat:
//   90°  = an exact hemisphere
//   >90° = the cut moves PAST the centre toward the front, leaving a fuller
//          rounded back and a flat face narrower than the head.
// Single tunable knob — nudge it up for a smaller face / fuller back, down toward
// 90 for a hemisphere. Default tuned to the reference shape.
const HEAD_CUT_DEG = 128;

// Vertical position of the head centre (metres). Raised so the flat face clears
// the torso: the body capsule's top is at ~1.46m, so this keeps most of the face
// above it, leaving only a small sliver of its bottom overlapping the body (which
// keeps the head looking attached). Single knob — nudge to taste.
const HEAD_Y = 1.62;

// makeHead — a sphere truncated by an off-centre flat cut: a fuller rounded back
// with a flat, circular face (narrower than the head) on the body's FORWARD side
// (-Z), so facing is readable at a glance and turns with the body's yaw. The flat
// face keeps a profile image crisp (flat image on a flat surface).
//
// Built without clipping planes: the back is a partial SphereGeometry (front cap
// removed via thetaLength) whose opening is a clean flat circle, capped by a
// CircleGeometry disc sitting flush in the opening.
//
// PROMPT 2 MOUNT POINT: that disc is its own mesh, named 'faceMount', carrying a
// dedicated material. To show a user's Nostr profile image, set
//   faceMount.material.map = <texture>; faceMount.material.needsUpdate = true;
// nothing else needs to change. For now it's a plain placeholder panel.
function makeHead() {
  const head = new THREE.Group();
  const cut = THREE.MathUtils.degToRad(HEAD_CUT_DEG);

  // Rounded back: a partial sphere covering its pole down to `cut`, removing the
  // front cap. Built around the +Y pole, then rotated so the pole points +Z (back)
  // and the flat opening faces -Z (forward).
  const skull = new THREE.Mesh(
    new THREE.SphereGeometry(HEAD_RADIUS, 24, 16, 0, Math.PI * 2, 0, cut),
    new THREE.MeshStandardMaterial({ color: 0xe8e8ef, roughness: 0.6 }),
  );
  skull.rotation.x = Math.PI / 2; // +Y pole → +Z (back); opening → -Z (forward)
  head.add(skull);

  // Flat circular face capping the opening: radius = opening radius, positioned
  // flush in the opening plane, facing forward (-Z). CircleGeometry faces +Z by
  // default, so flip it. Past-centre cut ⇒ cos(cut) < 0 ⇒ the opening sits in
  // front of centre (negative z).
  const openingRadius = HEAD_RADIUS * Math.sin(cut);
  const openingZ = HEAD_RADIUS * Math.cos(cut);
  const faceMount = new THREE.Mesh(
    new THREE.CircleGeometry(openingRadius, 32),
    new THREE.MeshStandardMaterial({ color: 0x222a3a, roughness: 0.85, metalness: 0 }),
  );
  faceMount.name = 'faceMount';
  faceMount.rotation.y = Math.PI;
  faceMount.position.z = openingZ;
  head.add(faceMount);

  head.position.y = HEAD_Y;
  return head;
}

// Build one capsule avatar at a given colour. Height ~1.7m, base at y=0.
// withHead:false omits the head — used for the LOCAL body, where the camera sits
// where the head would be (a head mesh there would render over the view); remote
// viewers still see our full flat-faced head via their own AvatarPool.
function makeCapsule(color, { withHead = true } = {}) {
  const group = new THREE.Group();

  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.28, 0.9, 6, 12),
    new THREE.MeshStandardMaterial({
      color, emissive: color, emissiveIntensity: BODY_EMISSIVE_INTENSITY,
      roughness: 0.7, metalness: 0.05,
    }),
  );
  body.position.y = 0.73; // capsule centre so its feet sit on y=0
  body.name = 'body';     // emote animations target this mesh (not the group → no fight with position/yaw lerp)
  group.add(body);

  if (withHead) group.add(makeHead());

  return group;
}

// ── Tracked hands (4.8) ──────────────────────────────────────────────────────────
// Cheap mitts mirrored at the controllers' poses — no finger articulation v1. Shared
// geometry; one material per body colour (both hands share it). Encoding: two transforms
// (position 3 + quaternion 4) each, RELATIVE TO THE BODY ROOT → 14 floats on the heartbeat.
const _handGeo = new THREE.CapsuleGeometry(0.05, 0.07, 4, 8);
export function makeHand(colorHex) {
  return new THREE.Mesh(_handGeo, new THREE.MeshStandardMaterial({
    color: colorHex, emissive: colorHex, emissiveIntensity: BODY_EMISSIVE_INTENSITY, roughness: 0.7, metalness: 0.05,
  }));
}

// ── Emotes (4.8) — short procedural transforms in the avatar's abstract language ──
// Each animates the BODY mesh (+ head bob) over ~1.7s with a smooth in/out envelope, then
// resets. NO skeletons. Hands (if the avatar has broadcast ones) already move for real, so
// emotes don't touch them. The floating emoji burst is spawned separately (zapEffect).
export const EMOTES = {
  wave:     { emoji: '👋', dur: 1.8 },
  clap:     { emoji: '👏', dur: 1.6 },
  thumbsup: { emoji: '👍', dur: 1.6 },
  point:    { emoji: '⚡', dur: 1.7 },
};
export function playEmote(group, kind) {
  if (!group || !EMOTES[kind]) return;
  group.userData.emote = { kind, t: 0, dur: EMOTES[kind].dur };
}
export function tickEmote(group, dt) {
  const e = group.userData.emote;
  if (!e) return;
  const body = group.getObjectByName('body');
  const head = group.getObjectByName('faceMount')?.parent || null;
  e.t += dt;
  const k = Math.min(1, e.t / e.dur);
  const env = Math.sin(Math.PI * k);          // 0 → 1 → 0 envelope (no snap in/out)
  if (body) {
    if (e.kind === 'wave')     { body.rotation.z = Math.sin(e.t * 13) * 0.20 * env; }
    else if (e.kind === 'clap'){ const c = Math.abs(Math.sin(e.t * 15)) * env; body.position.y = 0.73 - c * 0.05; body.scale.set(1 + c * 0.06, 1 - c * 0.05, 1 + c * 0.06); }
    else if (e.kind === 'thumbsup') { body.position.y = 0.73 + Math.sin(e.t * 6) * 0.12 * env; }
    else if (e.kind === 'point'){ body.rotation.x = -0.28 * env; body.position.z = -0.12 * env; }
  }
  if (head) head.position.y = HEAD_Y + (e.kind === 'thumbsup' ? 0.06 : 0.03) * env * Math.sin(e.t * 5);
  if (k >= 1) {                                // done → reset cleanly
    if (body) { body.rotation.set(0, 0, 0); body.position.set(0, 0.73, 0); body.scale.set(1, 1, 1); }
    if (head) head.position.y = HEAD_Y;
    group.userData.emote = null;
  }
}

// ── Smoking-zone cigarette prop (Prompt 4.4) ─────────────────────────────────────
// A cheap lit cigarette at the mouth of each Smoking occupant: a white stick + glowing
// ember + a soft smoke puff that rises and fades (a STATIC wisp under prefers-reduced-
// motion). Purely a LOCAL render keyed to the peer's broadcast zone — no networking
// beyond zone presence. attach/detach is idempotent; ticked only for those in-zone.
const REDUCE_MOTION = matchMedia('(prefers-reduced-motion: reduce)').matches;
let _smokeTex = null;
function smokeTexture() {
  if (_smokeTex) return _smokeTex;
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(210,210,220,0.5)'); grad.addColorStop(1, 'rgba(210,210,220,0)');
  g.fillStyle = grad; g.fillRect(0, 0, 64, 64);
  _smokeTex = new THREE.CanvasTexture(c); _smokeTex.colorSpace = THREE.SRGBColorSpace;
  return _smokeTex;
}

export function setCigarette(group, on) {
  const head = group.getObjectByName('faceMount')?.parent;
  if (!head) return;
  const existing = head.getObjectByName('cigarette');
  if (!!on === !!existing) return;                 // idempotent
  if (!on) { head.remove(existing); existing.traverse((o) => { o.geometry?.dispose?.(); o.material?.dispose?.(); }); return; }

  const cig = new THREE.Group(); cig.name = 'cigarette';
  cig.position.set(0.04, -0.055, -0.14);           // at the mouth: front of the flat face, a touch low
  cig.rotation.set(-0.35, 0, 0.12);                // angled down + out
  const stick = new THREE.Mesh(
    new THREE.CylinderGeometry(0.011, 0.011, 0.12, 8),
    new THREE.MeshStandardMaterial({ color: 0xf4efe6, emissive: 0x201a12, roughness: 0.9 }),
  );
  stick.rotation.x = Math.PI / 2; stick.position.z = -0.06; cig.add(stick);
  const ember = new THREE.Mesh(
    new THREE.CylinderGeometry(0.013, 0.013, 0.018, 8),
    new THREE.MeshBasicMaterial({ color: 0xff5a1e }),   // glowing tip (unlit basic = always bright)
  );
  ember.rotation.x = Math.PI / 2; ember.position.z = -0.12; cig.add(ember);
  const smoke = new THREE.Sprite(new THREE.SpriteMaterial({ map: smokeTexture(), transparent: true, depthWrite: false, opacity: 0.5 }));
  smoke.scale.setScalar(0.08); smoke.position.set(0, 0.04, -0.11); cig.add(smoke);
  if (!REDUCE_MOTION) {
    let t = Math.random();
    cig.userData.tick = (dt) => {                  // transform-only puff loop (cheap; no per-frame canvas)
      t += dt * 0.6; if (t > 1) t -= 1;
      smoke.position.y = 0.04 + t * 0.12;
      smoke.material.opacity = 0.5 * (1 - t);
      smoke.scale.setScalar(0.06 + t * 0.06);
    };
  } else {
    smoke.material.opacity = 0.22;                 // static wisp, no motion
  }
  head.add(cig);
}
// Advance the smoke puff for one in-zone avatar (no-op if it has no cigarette / reduced motion).
export function tickCigarette(group, dt) {
  group.getObjectByName('faceMount')?.parent?.getObjectByName('cigarette')?.userData.tick?.(dt);
}

// The local player's own body. Headless on purpose (see makeCapsule): the camera
// is at head height, so the torso reads as "you" when you look down / in VR while
// keeping the forward view clear. Remote viewers see our FULL capsule via their
// own AvatarPool, fed by our presence heartbeat. SEAM: reskin to Keyface here.
export function createPlayerBody(color) {
  return makeCapsule(color, { withHead: false });
}

// ── Identity rendering (Phase 2) ─────────────────────────────────────────────────
// Paint an identity onto a body: the profile picture (or a deterministic keyface) on
// the faceMount disc, plus an over-head name label. Pure presentation — the identity
// object comes from the identity service (the single source of identity).
export function applyIdentity(group, identity) {
  const face = group.getObjectByName('faceMount');
  if (face) {
    const tex = identity.picture
      ? new THREE.TextureLoader().load(identity.picture)        // REAL: profile image
      : new THREE.CanvasTexture(drawKeyface(identity.pubkey));   // MOCK: keyface
    tex.colorSpace = THREE.SRGBColorSpace;
    face.material.map = tex;
    face.material.color.set(0xffffff); // let the texture show its true colours
    face.material.needsUpdate = true;
  }
  // badge = attendee gem ('supporter'|'patron'|null); speaker = 🎙 mark (from booking a slot).
  // Both can show — the label draws the gem then the mic (combinable).
  setNameLabel(group, identity.name, identity.badge || null, !!identity.speaker);
  group.userData.identity = identity; // so click-picking can read it (Phase 2.2)
}

// Over-head name plate: a camera-facing sprite (Live Console: mono text on a glass
// pill). Re-used per group so re-identifying just swaps the texture.
function setNameLabel(group, name, badge = null, speaker = false) {
  const canvas = nameCanvas(name, badge, speaker);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  let sprite = group.userData.nameSprite;
  if (!sprite) {
    sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
    sprite.position.set(0, HEAD_Y + 0.42, 0); // just above the head
    sprite.renderOrder = 2;
    group.add(sprite);
    group.userData.nameSprite = sprite;
  } else {
    sprite.material.map?.dispose?.();
    sprite.material.map = tex;
    sprite.material.needsUpdate = true;
  }
  const h = 0.2;
  sprite.scale.set(h * (canvas.width / canvas.height), h, 1);
}

// Paid tiers get a small badge marker baked into the label canvas (no extra mesh): a subtle
// gem for Supporter, a brighter ringed star for Patron. Cheap — a few canvas ops.
const BADGE = {
  supporter: { color: '#27c6c6', ring: 'rgba(39,198,198,0.5)' },
  patron:    { color: '#ffcf5a', ring: 'rgba(255,207,90,0.6)' },
};
function nameCanvas(name, badge = null, speaker = false) {
  const dpr = 2, padX = 18, fontPx = 30, font = `600 ${fontPx}px ui-monospace, "SF Mono", Menlo, monospace`;
  const gem = badge && BADGE[badge] ? 24 : 0;    // attendee tier gem
  const mic = speaker ? 22 : 0;                  // 🎙 speaker mark
  const bw = gem + mic;                          // extra left space for the marks
  const m = document.createElement('canvas').getContext('2d');
  m.font = font;
  const w = Math.ceil(m.measureText(name).width) + padX * 2 + bw;
  const h = fontPx + 22;
  const c = document.createElement('canvas');
  c.width = w * dpr; c.height = h * dpr;
  const g = c.getContext('2d');
  g.scale(dpr, dpr);
  roundRect(g, 0.5, 0.5, w - 1, h - 1, 9);
  g.fillStyle = 'rgba(12,14,19,0.78)'; g.fill();
  // Border echoes the highest-priority mark (patron > supporter > speaker > none).
  g.strokeStyle = badge && BADGE[badge] ? BADGE[badge].ring : speaker ? 'rgba(255,178,74,0.5)' : 'rgba(255,255,255,0.13)';
  g.lineWidth = bw ? 1.5 : 1; g.stroke();
  g.fillStyle = '#eceef5'; g.font = font; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(name, (w + bw) / 2, h / 2 + 1); // name centred in the space right of the marks
  let x = padX + 4;
  if (gem) { drawBadge(g, x + 7, h / 2, badge); x += gem; } // gem first…
  if (mic) drawSpeakerMark(g, x + 7, h / 2);                // …then the mic (combinable)
  return c;
}
// A small diamond gem in the tier colour; Patron gets a bright core + ring to read as higher.
function drawBadge(g, cx, cy, badge) {
  const b = BADGE[badge]; const r = 7;
  g.save();
  g.translate(cx, cy); g.rotate(Math.PI / 4);
  if (badge === 'patron') { g.shadowColor = b.ring; g.shadowBlur = 8; }
  g.fillStyle = b.color; g.fillRect(-r, -r, r * 2, r * 2);
  if (badge === 'patron') { g.shadowBlur = 0; g.fillStyle = '#fff6e0'; g.fillRect(-r / 2.4, -r / 2.4, r / 1.2, r / 1.2); }
  g.restore();
}
// The 🎙 speaker mark — a small orange mic (head + stand), distinct from the tier gems.
function drawSpeakerMark(g, cx, cy) {
  g.save();
  g.translate(cx, cy);
  g.fillStyle = '#ffb24a'; g.strokeStyle = '#ffb24a'; g.lineWidth = 1.6; g.lineCap = 'round';
  roundRect(g, -3.5, -8, 7, 10, 3.5); g.fill();          // mic head
  g.beginPath(); g.moveTo(0, 2); g.lineTo(0, 6); g.stroke();     // stand
  g.beginPath(); g.moveTo(-3.5, 6.5); g.lineTo(3.5, 6.5); g.stroke(); // base
  g.restore();
}
function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

// A few static audience capsules as ambiance so a solo user isn't alone. Placed in
// the audience area, clear of both spawn points and the stage. Returns each one's
// { group, position } — the position feeds the separation system (keep the player
// out of them), the group lets main attach a mock identity (face + name).
export function seedPlaceholders(scene) {
  const audienceColors = [0x5b8cff, 0x9b6bff, 0x3fd0c9];
  const spots = [
    [-2.4, 0, 0],
    [2.6, 0, 0.4],
    [-1.2, 0, 2.2],
  ];
  return spots.map(([x, y, z], i) => {
    const group = makeCapsule(audienceColors[i % audienceColors.length]);
    group.position.set(x, y, z);
    scene.add(group);
    return { group, position: new THREE.Vector3(x, y, z) };
  });
}

// ── AvatarPool ──────────────────────────────────────────────────────────────────
// Manages one capsule per remote participant id. Positions are smoothed toward the
// last received presence sample so movement looks continuous between heartbeats.
export class AvatarPool {
  constructor(scene, { onSpawn } = {}) {
    this.scene = scene;
    this.byId = new Map(); // id → { group, target: Vector3 }
    this.onSpawn = onSpawn || null; // (id, group) when a remote avatar first appears
  }

  // Create-or-update a remote avatar's target position + yaw (+ optional hand transforms).
  upsert(id, position, yaw = 0, hands = null) {
    let entry = this.byId.get(id);
    const isNew = !entry;
    if (isNew) {
      // Derive a stable hue from the id so each peer keeps a consistent colour.
      const hue = [...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
      const hex = new THREE.Color().setHSL(hue / 360, 0.6, 0.6).getHex();
      const group = makeCapsule(hex);
      this.scene.add(group);
      entry = { group, hex, target: new THREE.Vector3(), targetYaw: yaw, hands: null, handTargets: null };
      this.byId.set(id, entry);
    }
    entry.target.set(position[0], position[1], position[2]);
    entry.targetYaw = yaw;
    this._setHands(entry, hands, isNew);
    // Snap a freshly-spawned avatar straight to its pose so it doesn't glide in
    // from the origin on its first frame, then let the caller attach its identity.
    if (isNew) {
      entry.group.position.copy(entry.target);
      entry.group.rotation.y = yaw;
      if (this.onSpawn) this.onSpawn(id, entry.group);
    }
    return entry;
  }

  // Remove a participant who left.
  remove(id) {
    const entry = this.byId.get(id);
    if (!entry) return;
    this.scene.remove(entry.group);
    this.byId.delete(id);
  }

  // Drop anyone we haven't heard from — call with the current live id set.
  prune(liveIds) {
    for (const id of this.byId.keys()) if (!liveIds.has(id)) this.remove(id);
  }

  // Attach/refresh/hide a peer's two hand proxies from a 14-float sample (or hide on null —
  // headless/no-data peers never get default T-pose hands). Hands are children of the group,
  // so they inherit its position + yaw; their LOCAL transform is the body-relative hand pose.
  _setHands(entry, hands, isNew) {
    if (hands && hands.length === 14) {
      if (!entry.hands) {
        entry.hands = [makeHand(entry.hex), makeHand(entry.hex)];
        entry.handTargets = [{ p: new THREE.Vector3(), q: new THREE.Quaternion() }, { p: new THREE.Vector3(), q: new THREE.Quaternion() }];
        for (const m of entry.hands) entry.group.add(m);
      }
      for (let i = 0; i < 2; i++) {
        const o = i * 7;
        entry.handTargets[i].p.set(hands[o], hands[o + 1], hands[o + 2]);
        entry.handTargets[i].q.set(hands[o + 3], hands[o + 4], hands[o + 5], hands[o + 6]);
        entry.hands[i].visible = true;
        if (isNew) { entry.hands[i].position.copy(entry.handTargets[i].p); entry.hands[i].quaternion.copy(entry.handTargets[i].q); } // snap on first sight
      }
    } else if (entry.hands) {
      for (const m of entry.hands) m.visible = false;   // flat/mobile / dropped hands → no hands
      entry.handTargets = null;
    }
  }

  // Per-frame smoothing toward each target position + yaw (+ hand transforms).
  update(dt) {
    const t = Math.min(1, dt * 8); // critically-ish damped lerp
    for (const entry of this.byId.values()) {
      const { group, target, targetYaw } = entry;
      group.position.lerp(target, t);
      // Shortest-path yaw lerp (handles the ±π wraparound).
      let d = targetYaw - group.rotation.y;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      group.rotation.y += d * t;
      if (entry.hands && entry.handTargets) {
        for (let i = 0; i < 2; i++) {
          if (!entry.hands[i].visible) continue;
          entry.hands[i].position.lerp(entry.handTargets[i].p, t);
          entry.hands[i].quaternion.slerp(entry.handTargets[i].q, t);
        }
      }
      tickEmote(group, dt);   // advance any active emote (no-op when idle)
    }
  }
}
