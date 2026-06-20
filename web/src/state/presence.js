import { AvatarPool } from '../room/avatars.js';

// state/presence.js — lightweight "where is everyone" over the LiveKit data channel.
//
// Each client broadcasts { t:'presence', p:[x,y,z], yaw } a few times a second
// (lossy, unreliable — a dropped frame just means the next one wins). Inbound
// presence from other clients drives an AvatarPool, so everyone sees everyone move
// and turn in near-real time. This validates the shared-state pipe that later
// prompts reuse for "who holds the stage", zaps, sponsor state, etc.
//
// We don't put our own id in the payload — LiveKit tells the receiver who sent each
// message (the participant identity), which is authoritative and unspoofable here.

const SEND_HZ = 6;                 // heartbeats per second (throttled)
const SEND_INTERVAL = 1000 / SEND_HZ;
const STALE_MS = 4000;             // drop avatars we haven't heard from in this long

// getPose() returns the local player's pose: { x, y, z, yaw }.
// staticBodies: world positions of the seeded ambiance capsules (Vector3-like with
// .x/.z) — separated against too, so the player can't stand inside them either.
// onAvatarSpawn(id, group): fired when a remote avatar first appears, so the caller
// can attach its (mock) identity — keeps identity out of the presence path.
export function createPresence(voice, scene, getPose, staticBodies = [], { onAvatarSpawn } = {}) {
  const pool = new AvatarPool(scene, { onSpawn: onAvatarSpawn });
  const lastSeen = new Map(); // id → timestamp

  // Inbound: update/spawn a remote avatar for any presence message.
  voice.onData((id, msg) => {
    if (!msg || msg.t !== 'presence' || !Array.isArray(msg.p)) return;
    lastSeen.set(id, performance.now());
    pool.upsert(id, msg.p, typeof msg.yaw === 'number' ? msg.yaw : 0);
  });

  let sendAcc = 0;

  function update(dt) {
    // Throttled outbound heartbeat of our current ground pose (position + yaw).
    sendAcc += dt * 1000;
    if (sendAcc >= SEND_INTERVAL) {
      sendAcc = 0;
      const pose = getPose();
      voice.sendData({
        t: 'presence',
        p: [round(pose.x), round(pose.y), round(pose.z)],
        yaw: round(pose.yaw),
      });
    }

    // Expire anyone who's gone quiet, then smooth the rest toward their targets.
    const now = performance.now();
    const live = new Set();
    for (const [id, ts] of lastSeen) {
      if (now - ts > STALE_MS) lastSeen.delete(id);
      else live.add(id);
    }
    pool.prune(live);
    pool.update(dt);
  }

  // Lightweight avatar separation (local-only, no physics). If `pos` is closer than
  // `minGap` to ANY other body — live participant OR static seeded prop — return the
  // {x,z} nudge that pushes it out to that gap (the single deepest overlap; cheap
  // O(bodies)). main applies it to the local rig then re-clamps. Each client pushes
  // only ITSELF, so two live people resolve mutually; static props don't move.
  function separation(pos, minGap) {
    let best = null, bestPen = 0;
    const consider = (bx, bz) => {
      const dx = pos.x - bx, dz = pos.z - bz;
      const d = Math.hypot(dx, dz);
      if (d < minGap && d > 1e-3) {
        const pen = minGap - d;
        if (pen > bestPen) { bestPen = pen; best = { x: (dx / d) * pen, z: (dz / d) * pen }; }
      }
    };
    for (const { group } of pool.byId.values()) consider(group.position.x, group.position.z);
    for (const b of staticBodies) consider(b.x, b.z);
    return best;
  }

  // Live remote avatar root groups (for click-picking). Seeded ambiance is tracked
  // separately by the caller.
  function avatars() {
    return [...pool.byId.values()].map((e) => e.group);
  }

  return { update, separation, avatars };
}

// Trim to mm precision — keeps presence payloads tiny over the wire.
const round = (n) => Math.round(n * 1000) / 1000;
