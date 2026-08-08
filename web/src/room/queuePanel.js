import * as THREE from 'three';
import { drawKeyface } from '../identity/keyface.js';
import { QUESTIONER_POS, MIC_PLATFORM_TOP } from './zones.js';

// room/queuePanel.js — the in-world "take the mic" queue, rendered as a TABLE of queued
// entrants on the far-left board wall. Same cheap canvas technique as the comment cards,
// but distinguished by the Nostr-VIOLET accent (the reserved identity colour): violet
// frame + row separators + title/accents, vs the orange comment boards. The whole table
// is ONE canvas texture, re-drawn ONLY on queue change (never per frame). A ring at the
// pedestal pulses when someone is "up".
//
// createQueuePanel(scene, { queue }) → { update(dt), refresh(), dispose() }

const VIOLET = '#9b6cff';        // Nostr identity accent (matches --violet)
const VIOLET_DIM = 'rgba(155,108,255,0.55)';
const PANEL_W = 2.3;
const SHOW_N = 3;                 // next few entrants
const CW = 660, TITLE_H = 84, ROW_H = 122;
const CH = TITLE_H + SHOW_N * ROW_H; // fixed canvas → constant panel size (empty or full)

export function createQueuePanel(scene, { queue }) {
  const group = new THREE.Group();
  // Far-left board slot: outboard of the TOP ZAPPED screen (x=-7), on the same wall, so
  // it doesn't block the main screen or the speaker from the audience floor. Matches the
  // boards' inward-facing yaw. (The "you're up" ring below stays at the pedestal.)
  group.position.set(-10.3, 2.6, -6.0);
  group.rotation.y = 0.5;

  const material = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false });
  const table = new THREE.Mesh(new THREE.PlaneGeometry(PANEL_W, PANEL_W * (CH / CW)), material);
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

// The whole queue table on one canvas: violet frame + title, then rank · keyface · name ·
// ⚡total rows separated by thin violet lines (pitch on the top entry). Empty → "— empty —".
function tableCanvas(list) {
  const cv = document.createElement('canvas');
  cv.width = CW; cv.height = CH;
  const g = cv.getContext('2d');

  // Panel body + violet frame.
  roundRect(g, 5, 5, CW - 10, CH - 10, 20);
  g.fillStyle = 'rgba(12,14,19,0.92)'; g.fill();
  g.lineWidth = 3; g.strokeStyle = VIOLET; g.stroke();

  // Title.
  g.fillStyle = VIOLET;
  g.font = '700 40px ui-monospace, "SF Mono", Menlo, monospace';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText('MIC QUEUE', CW / 2, TITLE_H / 2 + 4);
  // Rule under the title.
  line(g, 20, TITLE_H, CW - 20, TITLE_H, VIOLET_DIM, 2);

  g.textAlign = 'left';
  if (!list.length) {
    g.fillStyle = 'rgba(236,238,245,0.5)';
    g.font = '400 32px ui-monospace, Menlo, monospace';
    g.textAlign = 'center';
    g.fillText('— empty —', CW / 2, TITLE_H + ROW_H / 2);
    return cv;
  }

  list.forEach((e, i) => {
    const top = TITLE_H + i * ROW_H;
    if (i > 0) line(g, 20, top, CW - 20, top, VIOLET_DIM, 1); // row separator

    const midY = top + 46;
    // rank
    g.fillStyle = VIOLET;
    g.font = '700 30px ui-monospace, Menlo, monospace';
    g.textBaseline = 'middle'; g.textAlign = 'left';
    g.fillText(`#${i + 1}`, 22, midY);
    // keyface
    g.drawImage(drawKeyface(e.pubkey, 80), 74, top + 14, 64, 64);
    // name
    g.fillStyle = '#eceef5';
    g.font = '600 28px ui-monospace, Menlo, monospace';
    g.fillText(`@${e.pubkey.slice(0, 8)}`, 152, midY);
    // ⚡ total (violet, right)
    g.fillStyle = VIOLET;
    g.font = '700 28px ui-monospace, Menlo, monospace';
    g.textAlign = 'right';
    g.fillText(`⚡ ${e.totalSats.toLocaleString('en-US')}`, CW - 24, midY);
    g.textAlign = 'left';
    // pitch on the top entry only
    if (i === 0 && e.pitch) {
      g.fillStyle = 'rgba(236,238,245,0.78)';
      g.font = '400 24px system-ui, sans-serif';
      g.fillText(clip(g, e.pitch, CW - 176), 152, top + 86);
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
