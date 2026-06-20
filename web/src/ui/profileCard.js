import * as THREE from 'three';
import { drawKeyface } from '../identity/keyface.js';

// ui/profileCard.js — the in-world 3D profile card (works in flat, VR, AR — it's a
// billboarded panel in the scene, not a DOM overlay). One card at a time: open()
// disposes any previous card; close() disposes geometry/material/texture so nothing
// is left orphaned. The canvas texture is redrawn only on open / on change (follow
// toggle) — never per frame. Billboarding is a cheap per-frame quaternion copy.
//
// It is purely presentation: it draws an identity (from the identity service) and
// REPORTS which region was clicked via hitTest(); the caller (main) dispatches the
// Visit/Follow/Zap/Close actions through its own named handlers.

const W = 512, H = 336, DPR = 2;          // canvas (logical px)
const CARD_W = 0.95, CARD_H = CARD_W * (H / W); // metres

// Button + close-X hit regions, in canvas coords.
function regions() {
  const m = 22, gap = 12, by = H - 74, bh = 56;
  const bw = (W - m * 2 - gap * 2) / 3;
  return [
    { id: 'close',  x: W - 46, y: 12, w: 34, h: 34 },
    { id: 'visit',  x: m,                  y: by, w: bw, h: bh },
    { id: 'follow', x: m + bw + gap,       y: by, w: bw, h: bh },
    { id: 'zap',    x: m + (bw + gap) * 2, y: by, w: bw, h: bh },
  ];
}

export function createProfileCard(scene) {
  let card = null; // { group, panel, tex, canvas, profile }
  const _q = new THREE.Quaternion();

  function draw(canvas, profile, following) {
    const g = canvas.getContext('2d');
    g.save(); g.scale(DPR, DPR);
    g.clearRect(0, 0, W, H);

    // glass panel
    roundRect(g, 1.5, 1.5, W - 3, H - 3, 18);
    g.fillStyle = 'rgba(12,14,19,0.93)'; g.fill();
    g.strokeStyle = 'rgba(255,255,255,0.14)'; g.lineWidth = 1.5; g.stroke();
    // orange accent rule
    g.fillStyle = '#f7931a'; roundRect(g, 18, 12, W - 36, 3, 2); g.fill();

    // keyface (or, REAL, the profile picture)
    if (!profile.picture) {
      g.save(); roundRect(g, 24, 32, 76, 76, 12); g.clip();
      g.drawImage(drawKeyface(profile.pubkey, 96), 24, 32, 76, 76); g.restore();
    }

    // name · npub-short · nip05
    g.textAlign = 'left';
    g.fillStyle = '#eceef5';
    g.font = '600 27px ui-monospace, "SF Mono", Menlo, monospace';
    g.fillText(truncate(g, profile.name, W - 130), 116, 60);
    g.fillStyle = 'rgba(236,238,245,0.55)';
    g.font = '15px ui-monospace, "SF Mono", Menlo, monospace';
    g.fillText(shortNpub(profile.npub), 116, 86);
    g.fillStyle = 'rgba(247,147,26,0.85)';
    g.fillText(profile.nip05 || '', 116, 108);

    // close X
    const r = regions();
    g.strokeStyle = 'rgba(236,238,245,0.6)'; g.lineWidth = 2; g.lineCap = 'round';
    const x0 = r[0].x + 9, y0 = r[0].y + 9, x1 = r[0].x + r[0].w - 9, y1 = r[0].y + r[0].h - 9;
    g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.moveTo(x1, y0); g.lineTo(x0, y1); g.stroke();

    // action buttons
    button(g, r[1], 'Visit profile', {});
    button(g, r[2], following ? 'Following' : 'Follow', { active: following });
    button(g, r[3], '⚡ Zap', { dim: true }); // dim: wallet not built yet

    g.restore();
  }

  function button(g, r, label, { active, dim } = {}) {
    roundRect(g, r.x, r.y, r.w, r.h, 10);
    if (active) {
      g.fillStyle = '#f7931a'; g.fill(); g.fillStyle = '#1a1206';
    } else {
      g.fillStyle = dim ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.07)'; g.fill();
      g.strokeStyle = dim ? 'rgba(255,255,255,0.10)' : 'rgba(247,147,26,0.55)';
      g.lineWidth = 1.5; g.stroke();
      g.fillStyle = dim ? 'rgba(236,238,245,0.4)' : '#ffb24a';
    }
    g.font = '600 17px ui-monospace, "SF Mono", Menlo, monospace';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(label, r.x + r.w / 2, r.y + r.h / 2 + 1);
    g.textAlign = 'left'; g.textBaseline = 'alphabetic';
  }

  function open(profile, anchorWorldPos, following) {
    close();
    const canvas = document.createElement('canvas');
    canvas.width = W * DPR; canvas.height = H * DPR;
    draw(canvas, profile, following);

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    const panel = new THREE.Mesh(
      new THREE.PlaneGeometry(CARD_W, CARD_H),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, side: THREE.DoubleSide }),
    );
    const group = new THREE.Group();
    group.add(panel);
    group.position.copy(anchorWorldPos);
    group.renderOrder = 10;
    scene.add(group);
    card = { group, panel, tex, canvas, profile };
  }

  // Redraw only on change (e.g. follow toggled) — not per frame.
  function refresh(following) {
    if (!card) return;
    draw(card.canvas, card.profile, following);
    card.tex.needsUpdate = true;
  }

  function close() {
    if (!card) return;
    scene.remove(card.group);
    card.panel.geometry.dispose();
    card.panel.material.dispose();
    card.tex.dispose();
    card = null;
  }

  // Cheap billboard: face the (active) camera each frame.
  function update(camera) {
    if (!card) return;
    camera.getWorldQuaternion(_q);
    card.group.quaternion.copy(_q);
  }

  // raycaster must already be configured by the caller (mouse NDC or VR controller).
  // → 'visit' | 'follow' | 'zap' | 'close' | 'panel' (hit, no button) | null (miss).
  function hitTest(raycaster) {
    if (!card) return null;
    const hit = raycaster.intersectObject(card.panel, false)[0];
    if (!hit || !hit.uv) return null;
    const cx = hit.uv.x * W, cy = (1 - hit.uv.y) * H;
    for (const r of regions()) {
      if (cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h) return r.id;
    }
    return 'panel';
  }

  return {
    open, close, refresh, update, hitTest,
    isOpen: () => !!card,
    profile: () => (card ? card.profile : null),
  };
}

// ── canvas helpers ───────────────────────────────────────────────────────────────
function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r);
  g.closePath();
}
function shortNpub(npub) {
  return npub.length > 22 ? `${npub.slice(0, 14)}…${npub.slice(-6)}` : npub;
}
function truncate(g, text, maxW) {
  if (g.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && g.measureText(`${t}…`).width > maxW) t = t.slice(0, -1);
  return `${t}…`;
}
