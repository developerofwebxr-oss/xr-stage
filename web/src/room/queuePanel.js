import * as THREE from 'three';
import { drawKeyface } from '../identity/keyface.js';
import { QUESTIONER_POS, MIC_PLATFORM_TOP } from './zones.js';

// room/queuePanel.js — a small in-world panel beside the pedestal/floor mic showing the
// "take the mic" queue, so the room (incl. VR) can see who's up next. Same cheap canvas-
// card technique as the comment board: re-textured ONLY on queue change, never per frame.
// Plus a highlight ring at the questioner spot that pulses when someone is "up".
//
// createQueuePanel(scene, { queue }) → { update(dt), refresh(), dispose() }

const BITCOIN = 0xf7931a;
const PANEL_W = 2.0;
const SHOW_N = 3;                 // next few entrants
const ROW_H = 0.5, ROW_GAP = 0.08;

export function createQueuePanel(scene, { queue }) {
  const group = new THREE.Group();
  group.position.set(2.5, 1.7, -1.7);   // beside the mic, above the platform
  group.rotation.y = -0.25;             // angled toward the audience
  scene.add(group);

  const title = billboard('MIC QUEUE', 1.4, 0.34);
  title.position.set(0, 0.95, 0.02);
  group.add(title);

  const content = new THREE.Group();
  content.position.z = 0.02;
  group.add(content);

  let rows = []; // [{ mesh }]

  // "You're up" highlight — a ring at the questioner spot, shown+pulsing when current set.
  const upRing = new THREE.Mesh(
    new THREE.TorusGeometry(0.6, 0.05, 12, 48),
    new THREE.MeshBasicMaterial({ color: BITCOIN, transparent: true, opacity: 0, depthWrite: false }),
  );
  upRing.rotation.x = -Math.PI / 2;
  upRing.position.set(QUESTIONER_POS.x, MIC_PLATFORM_TOP + 0.03, QUESTIONER_POS.z);
  scene.add(upRing);
  let pulse = 0;

  function rebuild() {
    for (const { mesh } of rows) { content.remove(mesh); disposeMesh(mesh); }
    rows = [];
    const list = queue.list().slice(0, SHOW_N);
    if (!list.length) {
      const empty = billboard('— empty —', 1.6, 0.3, 'rgba(236,238,245,0.5)');
      empty.position.set(0, 0.3, 0.03);
      content.add(empty);
      rows.push({ mesh: empty });
      return;
    }
    list.forEach((e, i) => {
      const mesh = rowCard(e, i + 1, i === 0);
      mesh.position.set(0, 0.55 - i * (ROW_H + ROW_GAP), 0.03);
      content.add(mesh);
      rows.push({ mesh });
    });
  }

  const unsub = queue.onChange(rebuild);
  rebuild();

  function update(dt) {
    // Pulse the up-ring while someone is up; otherwise keep it hidden (cheap: one ring).
    if (queue.current()) {
      pulse += dt * 3;
      upRing.material.opacity = 0.4 + 0.35 * Math.sin(pulse);
    } else if (upRing.material.opacity !== 0) {
      upRing.material.opacity = 0;
    }
  }

  return { update, refresh: rebuild, dispose() { unsub(); } };
}

// One queue row: rank · keyface · @handle · ⚡total, and (top entry) its pitch line.
function rowCard(entry, rank, isTop) {
  const cv = document.createElement('canvas');
  cv.width = 512; cv.height = 128;
  const g = cv.getContext('2d');

  roundRect(g, 4, 4, cv.width - 8, cv.height - 8, 16);
  g.fillStyle = isTop ? 'rgba(247,147,26,0.14)' : 'rgba(12,14,19,0.9)'; g.fill();
  g.strokeStyle = isTop ? 'rgba(247,147,26,0.6)' : 'rgba(255,255,255,0.12)';
  g.lineWidth = 2; g.stroke();

  g.fillStyle = '#f7931a';
  g.font = '700 30px ui-monospace, Menlo, monospace';
  g.textBaseline = 'middle';
  g.fillText(`#${rank}`, 20, 40);

  const face = drawKeyface(entry.pubkey, 80);
  g.drawImage(face, 78, 20, 64, 64);

  g.fillStyle = '#eceef5';
  g.font = '600 26px ui-monospace, Menlo, monospace';
  g.fillText(`@${entry.pubkey.slice(0, 8)}`, 156, 40);

  g.textAlign = 'right';
  g.fillStyle = '#f7931a';
  g.font = '700 28px ui-monospace, Menlo, monospace';
  g.fillText(`⚡ ${entry.totalSats.toLocaleString('en-US')}`, cv.width - 20, 40);
  g.textAlign = 'left';

  // Pitch on the top (next-up) entry only.
  if (isTop && entry.pitch) {
    g.fillStyle = 'rgba(236,238,245,0.8)';
    g.font = '400 24px system-ui, sans-serif';
    g.fillText(clip(g, entry.pitch, cv.width - 36), 20, 96);
  }

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(PANEL_W, PANEL_W * (cv.height / cv.width)),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }),
  );
  return mesh;
}

function billboard(text, w, h, color = '#f7931a') {
  const cv = document.createElement('canvas');
  cv.width = 512; cv.height = Math.round(512 * (h / w));
  const g = cv.getContext('2d');
  g.fillStyle = color;
  g.font = `700 ${Math.round(cv.height * 0.62)}px ui-monospace, Menlo, monospace`;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.shadowColor = 'rgba(0,0,0,0.5)'; g.shadowBlur = 8;
  g.fillText(text, cv.width / 2, cv.height / 2);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return new THREE.Mesh(
    new THREE.PlaneGeometry(w, h),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }),
  );
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
function disposeMesh(mesh) {
  mesh.material.map?.dispose();
  mesh.material.dispose();
  mesh.geometry.dispose();
}
