import * as THREE from 'three';

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

// Build one capsule avatar at a given colour. Height ~1.7m, base at y=0.
// withHead:false omits the head sphere — used for the LOCAL body, where the camera
// sits where the head would be (a head mesh there would render over the view).
function makeCapsule(color, { withHead = true } = {}) {
  const group = new THREE.Group();

  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.28, 0.9, 6, 12),
    new THREE.MeshStandardMaterial({ color, roughness: 0.7, metalness: 0.05 }),
  );
  body.position.y = 0.73; // capsule centre so its feet sit on y=0
  group.add(body);

  if (withHead) {
    const head = new THREE.Mesh(
      new THREE.SphereGeometry(0.22, 16, 12),
      new THREE.MeshStandardMaterial({ color: 0xe8e8ef, roughness: 0.6 }),
    );
    head.position.y = 1.5;
    group.add(head);
  }

  return group;
}

// The local player's own body. Headless on purpose (see makeCapsule): the camera
// is at head height, so the torso reads as "you" when you look down / in VR while
// keeping the forward view clear. Remote viewers see our FULL capsule via their
// own AvatarPool, fed by our presence heartbeat. SEAM: reskin to Keyface here.
export function createPlayerBody(color) {
  return makeCapsule(color, { withHead: false });
}

// A few static audience capsules as ambiance so a solo user isn't alone. Placed in
// the audience area, clear of both spawn points and the stage — no static prop
// stands where a real person (you or a remote participant) will be.
export function seedPlaceholders(scene) {
  const audienceColors = [0x5b8cff, 0x9b6bff, 0x3fd0c9];
  const spots = [
    [-2.4, 0, 0],
    [2.6, 0, 0.4],
    [-1.2, 0, 2.2],
  ];
  spots.forEach(([x, y, z], i) => {
    const a = makeCapsule(audienceColors[i % audienceColors.length]);
    a.position.set(x, y, z);
    scene.add(a);
  });
}

// ── AvatarPool ──────────────────────────────────────────────────────────────────
// Manages one capsule per remote participant id. Positions are smoothed toward the
// last received presence sample so movement looks continuous between heartbeats.
export class AvatarPool {
  constructor(scene) {
    this.scene = scene;
    this.byId = new Map(); // id → { group, target: Vector3 }
  }

  // Create-or-update a remote avatar's target position + yaw from a presence sample.
  upsert(id, position, yaw = 0) {
    let entry = this.byId.get(id);
    const isNew = !entry;
    if (isNew) {
      // Derive a stable hue from the id so each peer keeps a consistent colour.
      const hue = [...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
      const group = makeCapsule(new THREE.Color().setHSL(hue / 360, 0.6, 0.6).getHex());
      this.scene.add(group);
      entry = { group, target: new THREE.Vector3(), targetYaw: yaw };
      this.byId.set(id, entry);
    }
    entry.target.set(position[0], position[1], position[2]);
    entry.targetYaw = yaw;
    // Snap a freshly-spawned avatar straight to its pose so it doesn't glide in
    // from the origin on its first frame.
    if (isNew) { entry.group.position.copy(entry.target); entry.group.rotation.y = yaw; }
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

  // Per-frame smoothing toward each target position + yaw.
  update(dt) {
    const t = Math.min(1, dt * 8); // critically-ish damped lerp
    for (const { group, target, targetYaw } of this.byId.values()) {
      group.position.lerp(target, t);
      // Shortest-path yaw lerp (handles the ±π wraparound).
      let d = targetYaw - group.rotation.y;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      group.rotation.y += d * t;
    }
  }
}
