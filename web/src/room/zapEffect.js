import * as THREE from 'three';

// room/zapEffect.js — a cheap in-world "zap burst" on the zapped avatar: a ⚡ + amount
// label that floats up and fades. IN-WORLD (parented to the avatar group) so it's
// visible in VR too, not just as a flat toast.
//
// Performance: nothing runs when idle — update(dt) early-returns with no active
// effects, so there's zero per-frame cost between zaps (keeps Quest at 72fps). Each
// burst is a single Sprite built on the event and fully DISPOSED when it ends.
//
//   const fx = createZapEffects();
//   fx.spawn(avatarGroup, amountSats);   // on wallet 'confirmed'
//   fx.update(dt);                        // once per frame

const LIFE = 0.9;    // seconds the burst lives
const RISE = 0.9;    // metres it floats upward
const START_Y = 1.9; // just above an avatar's head
const BITCOIN = '#f7931a';

export function createZapEffects() {
  const active = [];

  function spawn(group, amountSats) {
    if (!group) return;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: labelTexture(amountSats),
      transparent: true, depthWrite: false, depthTest: false, // always reads over the body
    }));
    sprite.scale.set(1.1, 0.55, 1);
    sprite.position.set(0, START_Y, 0);
    sprite.renderOrder = 999;
    group.add(sprite);
    active.push({ sprite, group, t: 0 });
  }

  function update(dt) {
    if (!active.length) return; // idle: no work
    for (let i = active.length - 1; i >= 0; i--) {
      const e = active[i];
      e.t += dt;
      const k = Math.min(1, e.t / LIFE);
      e.sprite.position.y = START_Y + RISE * k;
      e.sprite.material.opacity = 1 - k;
      const s = 1 + k * 0.4;                 // gentle grow as it rises
      e.sprite.scale.set(1.1 * s, 0.55 * s, 1);
      if (e.t >= LIFE) {
        e.group.remove(e.sprite);
        e.sprite.material.map?.dispose();
        e.sprite.material.dispose();
        active.splice(i, 1);
      }
    }
  }

  return { spawn, update };
}

// One small canvas → texture per burst (disposed on end). Not per-frame work.
function labelTexture(amountSats) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 128;
  const ctx = c.getContext('2d');
  ctx.font = 'bold 62px system-ui, -apple-system, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = 'rgba(0,0,0,0.65)';
  ctx.shadowBlur = 10;
  ctx.fillStyle = BITCOIN;
  ctx.fillText(`⚡ ${amountSats.toLocaleString('en-US')}`, 128, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
