import * as THREE from 'three';
import { drawKeyface } from '../identity/keyface.js';
import { QUESTIONER_POS, MIC_PLATFORM_TOP } from './zones.js';

// room/queuePanel.js — the in-world "take the mic" queue as a TABLE on the far-left board
// wall, a SIBLING of the TOP ZAPPED screen: same vertical extent (bottom + top aligned,
// same height), slightly NARROWER (it's a table, not a feed), in the Nostr-VIOLET accent
// (the reserved identity colour) vs the orange comment boards. The whole table is ONE
// OPAQUE canvas mesh (writes depth → no cross-panel bleed; the 3.11 solid-panel fix),
// re-textured ONLY on queue change. A ring at the pedestal pulses when someone is "up".
//
// createQueuePanel(scene, { queue }) → { update(dt), refresh(), dispose() }

const VIOLET = '#9b6cff';
const VIOLET_DIM = 'rgba(155,108,255,0.55)';
const BG = '#0b0d13';
// Match the comment boards' extent: SCREEN_H 3.6 centred at y 2.7, z -6.2 (see commentBoard).
const PANEL_W = 3.0, PANEL_H = 3.6;      // narrower than the 4.0-wide boards, same height
const SHOW_N = 4;
const CW = 600, CH = 720;                 // canvas matches the plane aspect (3.0:3.6)
const TITLE_H = 112, ROW_H = (CH - TITLE_H) / SHOW_N;

export function createQueuePanel(scene, { queue }) {
  const group = new THREE.Group();
  group.position.set(-10.6, 2.7, -6.2);   // far-left, aligned with TOP ZAPPED (x=-7)
  group.rotation.y = 0.5;                  // inward-facing, like the left board

  const material = new THREE.MeshBasicMaterial(); // OPAQUE: writes depth, occludes correctly
  const table = new THREE.Mesh(new THREE.PlaneGeometry(PANEL_W, PANEL_H), material);
  group.add(table);
  scene.add(group);

  // "You're up" highlight — a ring at the questioner spot, shown+pulsing when current set.
  const upRing = new THREE.Mesh(
    new THREE.TorusGeometry(0.6, 0.05, 12, 48),
    new THREE.MeshBasicMaterial({ color: 0x9b6cff, transparent: true, opacity: 0, depthWrite: false }),
  );
  upRing.rotation.x = -Math.PI / 2;
  upRing.position.set(QUESTIONER_POS.x, MIC_PLATFORM_TOP + 0.03, QUESTIONER_POS.z);
  scene.add(upRing);
  let pulse = 0;

  function rebuild() {
    material.map?.dispose();
    const tex = new THREE.CanvasTexture(tableCanvas(queue.list().slice(0, SHOW_N)));
    tex.colorSpace = THREE.SRGBColorSpace;
    material.map = tex;
    material.needsUpdate = true;
  }
  const unsub = queue.onChange(rebuild);
  rebuild();

  function update(dt) {
    if (queue.current()) {
      pulse += dt * 3;
      upRing.material.opacity = 0.4 + 0.35 * Math.sin(pulse);
    } else if (upRing.material.opacity !== 0) {
      upRing.material.opacity = 0;
    }
  }

  return { update, refresh: rebuild, dispose() { unsub(); material.map?.dispose(); material.dispose(); } };
}

// The whole queue table on one opaque canvas: solid dark fill + violet frame/title, then
// rank · keyface · name · ⚡total rows separated by thin violet lines (pitch on the top
// entry). Empty → "— empty —".
function tableCanvas(list) {
  const cv = document.createElement('canvas');
  cv.width = CW; cv.height = CH;
  const g = cv.getContext('2d');

  g.fillStyle = BG; g.fillRect(0, 0, CW, CH);           // fully opaque (no see-through)
  roundRect(g, 6, 6, CW - 12, CH - 12, 22);
  g.lineWidth = 3; g.strokeStyle = VIOLET; g.stroke();  // violet frame

  g.fillStyle = VIOLET;
  g.font = '700 50px ui-monospace, "SF Mono", Menlo, monospace';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText('MIC QUEUE', CW / 2, TITLE_H / 2 + 6);
  line(g, 24, TITLE_H, CW - 24, TITLE_H, VIOLET_DIM, 2);

  g.textAlign = 'left';
  if (!list.length) {
    g.fillStyle = 'rgba(236,238,245,0.5)';
    g.font = '400 34px ui-monospace, Menlo, monospace';
    g.textAlign = 'center';
    g.fillText('— empty —', CW / 2, TITLE_H + ROW_H / 2);
    return cv;
  }

  list.forEach((e, i) => {
    const top = TITLE_H + i * ROW_H;
    if (i > 0) line(g, 24, top, CW - 24, top, VIOLET_DIM, 1);
    const mid = top + ROW_H * 0.42;

    g.fillStyle = VIOLET;
    g.font = '700 32px ui-monospace, Menlo, monospace';
    g.textBaseline = 'middle'; g.textAlign = 'left';
    g.fillText(`#${i + 1}`, 26, mid);

    g.drawImage(drawKeyface(e.pubkey, 96), 74, top + ROW_H * 0.42 - 48, 96, 96);

    g.fillStyle = '#eceef5';
    g.font = '600 30px ui-monospace, Menlo, monospace';
    g.fillText(`@${e.pubkey.slice(0, 8)}`, 196, mid);

    g.fillStyle = VIOLET;
    g.font = '700 30px ui-monospace, Menlo, monospace';
    g.textAlign = 'right';
    g.fillText(`⚡ ${e.totalSats.toLocaleString('en-US')}`, CW - 26, mid);
    g.textAlign = 'left';

    if (i === 0 && e.pitch) {
      g.fillStyle = 'rgba(236,238,245,0.78)';
      g.font = '400 26px system-ui, sans-serif';
      g.fillText(clip(g, e.pitch, CW - 220), 196, top + ROW_H * 0.72);
    }
  });
  return cv;
}

function line(g, x1, y1, x2, y2, color, w) {
  g.strokeStyle = color; g.lineWidth = w;
  g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
}
function clip(g, text, maxW) {
  let t = text;
  while (g.measureText(`${t}…`).width > maxW && t.length) t = t.slice(0, -1);
  return t.length < text.length ? `${t}…` : text;
}
function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r);
  g.closePath();
}
