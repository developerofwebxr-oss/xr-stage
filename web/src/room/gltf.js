import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import * as THREE from 'three';

// room/gltf.js — one shared GLB loader (4.10). Owner GLBs live in /public → served at the site
// root (/foo.glb). meshopt-aware (owner assets may be gltfpack'd). ASYNC + GRACEFUL: a failed or
// missing load resolves to null so the caller draws its primitive placeholder instead — loads
// never block interaction. NOTE: gltfpack/draco compression is NOT wired into the build here;
// the GLBs are copied as-is (~1.4–1.6 MB each) — a compression pass is a later optimisation.

// The owner GLBs are DRACO-compressed → wire the DRACOLoader with three's bundled decoder,
// copied to /public/draco (no new npm dep, offline-capable). meshopt is also configured in case
// a future asset uses it.
let _loader = null;
function loader() {
  if (!_loader) {
    _loader = new GLTFLoader();
    const draco = new DRACOLoader().setDecoderPath('/draco/');
    _loader.setDRACOLoader(draco);
    _loader.setMeshoptDecoder(MeshoptDecoder);
  }
  return _loader;
}

// Resolve the loaded scene (a THREE.Group), or null on any error. Never rejects.
export function loadGLB(url) {
  return new Promise((resolve) => {
    try {
      loader().load(url, (g) => resolve(g.scene || g.scenes?.[0] || null),
        undefined, (err) => { console.warn('[glb] load failed:', url, err?.message || err); resolve(null); });
    } catch (err) { console.warn('[glb] loader error:', url, err?.message || err); resolve(null); }
  });
}

// Measure a loaded object's world-space bounds → { size, center, box }. Used to fit/scale GLBs.
export function measure(obj) {
  const box = new THREE.Box3().setFromObject(obj);
  const size = new THREE.Vector3(), center = new THREE.Vector3();
  box.getSize(size); box.getCenter(center);
  return { size, center, box };
}

// Uniformly scale an object so its largest bound = targetMax metres; return the applied scale.
export function fitToHeight(obj, targetMax) {
  const { size } = measure(obj);
  const max = Math.max(size.x, size.y, size.z) || 1;
  const s = targetMax / max;
  obj.scale.setScalar(s);
  return s;
}
