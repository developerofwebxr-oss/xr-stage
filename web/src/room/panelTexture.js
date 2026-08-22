import * as THREE from 'three';

// room/panelTexture.js — the ONE canvas→texture helper for in-world TEXT panels (plaques, boards,
// queue, offers, menu, station post, name labels). 4.19 #5 global sharpness fix:
//   • anisotropic filtering at the GPU max — the main win for oblique / distance blur;
//   • trilinear mipmapping (LinearMipmapLinear + generateMipmaps) so text stays crisp when minified.
// WebGL2 (three's default) supports NPOT mipmaps, so any canvas size is fine. This changes QUALITY
// only — callers keep their existing re-texture-on-change (needsUpdate) behaviour unchanged.

let _aniso = 8;                                   // sensible default until main reports the GPU max
export function setPanelAnisotropy(max) { _aniso = Math.max(1, max | 0); }

export function panelTexture(canvas) {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = _aniso;
  t.minFilter = THREE.LinearMipmapLinearFilter;   // trilinear: crisp at distance
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  return t;
}
