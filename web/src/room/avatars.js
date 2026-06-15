import * as THREE from 'three';

// room/avatars.js — placeholder people in the room.
//
// Two responsibilities, both deliberately simple so Prompt 2 can swap them out:
//   1. seedPlaceholders() — drops a few static capsules (audience + one on stage)
//      so the room never looks empty in screenshots / first load.
//   2. AvatarPool — spawns/moves/removes a capsule per REMOTE participant, driven
//      by presence heartbeats (see state/presence.js).
//
// SEAM: a capsule is just a body + a head. Prompt 2 replaces makeCapsule() with the
// deterministic "Keyface" avatar generated from a Nostr npub — same transform, same
// pool API, so nothing downstream changes.

const BITCOIN = 0xf7931a;

// Build one capsule avatar at a given colour. Height ~1.7m, base at y=0.
function makeCapsule(color) {
  const group = new THREE.Group();

  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.28, 0.9, 6, 12),
    new THREE.MeshStandardMaterial({ color, roughness: 0.7, metalness: 0.05 }),
  );
  body.position.y = 0.73; // capsule centre so its feet sit on y=0
  group.add(body);

  const head = new THREE.Mesh(
    new THREE.SphereGeometry(0.22, 16, 12),
    new THREE.MeshStandardMaterial({ color: 0xe8e8ef, roughness: 0.6 }),
  );
  head.position.y = 1.5;
  group.add(head);

  return group;
}

// A handful of fixed extras: 3 in the audience facing the stage, 1 on the stage.
export function seedPlaceholders(scene, stagePos) {
  const audienceColors = [0x5b8cff, 0x9b6bff, 0x3fd0c9];
  const spots = [
    [-2, 0, -2],
    [2.4, 0, -1.2],
    [0.4, 0, 1.6],
  ];
  spots.forEach(([x, y, z], i) => {
    const a = makeCapsule(audienceColors[i % audienceColors.length]);
    a.position.set(x, y, z);
    scene.add(a);
  });

  // The speaker, standing on the platform (its top sits at y≈0.4).
  const speaker = makeCapsule(BITCOIN);
  speaker.position.set(stagePos.x, 0.4, stagePos.z);
  scene.add(speaker);
}

// ── AvatarPool ──────────────────────────────────────────────────────────────────
// Manages one capsule per remote participant id. Positions are smoothed toward the
// last received presence sample so movement looks continuous between heartbeats.
export class AvatarPool {
  constructor(scene) {
    this.scene = scene;
    this.byId = new Map(); // id → { group, target: Vector3 }
  }

  // Create-or-update a remote avatar's target position from a presence sample.
  upsert(id, position) {
    let entry = this.byId.get(id);
    if (!entry) {
      // Derive a stable hue from the id so each peer keeps a consistent colour.
      const hue = [...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
      const group = makeCapsule(new THREE.Color().setHSL(hue / 360, 0.6, 0.6).getHex());
      this.scene.add(group);
      entry = { group, target: new THREE.Vector3() };
      this.byId.set(id, entry);
    }
    entry.target.set(position[0], position[1], position[2]);
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

  // Per-frame smoothing toward each target position.
  update(dt) {
    const t = Math.min(1, dt * 8); // critically-ish damped lerp
    for (const { group, target } of this.byId.values()) {
      group.position.lerp(target, t);
    }
  }
}
