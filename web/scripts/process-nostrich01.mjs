// Build-time asset pipeline for the Psycho nostrich parts (4.15). Reads the raw ~374k-tri scans
// from ~/Downloads/nostrich01 (NEVER edited), decimates each to a Quest-safe budget, resizes the
// texture, meshopt-compresses, and writes to web/public/nostrich01/. Re-runnable.
import fs from 'fs';
import path from 'path';
import { NodeIO } from '@gltf-transform/core';
import { EXTMeshoptCompression, KHRDracoMeshCompression } from '@gltf-transform/extensions';
import { weld, simplify, dedup, prune, textureCompress } from '@gltf-transform/functions';
import { MeshoptSimplifier, MeshoptEncoder, MeshoptDecoder } from 'meshoptimizer';
import draco3d from 'draco3d';
import sharp from 'sharp';

const SRC = path.join(process.env.HOME, 'Downloads', 'nostrich01');
const OUT = path.resolve('public', 'nostrich01');
fs.mkdirSync(OUT, { recursive: true });

// Per-part triangle targets (Quest-safe). Only one head renders at a time (visibility swap).
const TARGET = {
  nostrich01_body: 9000,
  nostrich01_head_normal: 5500, nostrich01_head_open_mouth: 5500,
  nostrich01_head_rage: 5500, nostrich01_head_psychotic_rage: 5500,
  nostrich01_neck_thick_bottom: 3000, nostrich_neck_thin_top: 2500,
  nostrich01_left_leg: 3000, nostrich01_right_leg: 3000,
};

await MeshoptSimplifier.ready; await MeshoptEncoder.ready;
const io = new NodeIO().registerExtensions([EXTMeshoptCompression, KHRDracoMeshCompression])
  .registerDependencies({
    'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder,
    'draco3d.decoder': await draco3d.createDecoderModule(), 'draco3d.encoder': await draco3d.createEncoderModule(),
  });

const rows = [];
for (const f of fs.readdirSync(SRC).filter((f) => f.endsWith('.glb')).sort()) {
  const base = f.replace('.glb', '');
  const doc = await io.read(path.join(SRC, f));
  const mesh = doc.getRoot().listMeshes()[0];
  const before = mesh.listPrimitives().reduce((n, p) => n + p.getIndices().getCount() / 3, 0);
  const ratio = Math.min(1, (TARGET[base] || 8000) / before);
  await doc.transform(
    weld({ tolerance: 0.002 }),   // merge near-coincident verts across shells so simplify can collapse further
    simplify({ simplifier: MeshoptSimplifier, ratio, error: 0.06, lockBorder: false }),
    dedup(), prune(),
    textureCompress({ encoder: sharp, targetFormat: 'jpeg', resize: [512, 512] }),
  );
  // meshopt-compress geometry for a small file
  doc.createExtension(EXTMeshoptCompression).setRequired(true)
    .setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
  const after = doc.getRoot().listMeshes()[0].listPrimitives().reduce((n, p) => n + p.getIndices().getCount() / 3, 0);
  await io.write(path.join(OUT, f), doc);
  const kb = (fs.statSync(path.join(OUT, f)).size / 1024).toFixed(0);
  rows.push(`${f.padEnd(38)} ${Math.round(before).toString().padStart(7)} -> ${Math.round(after).toString().padStart(6)} tris   ${kb.padStart(5)} KB`);
}
console.log('\n=== Psycho nostrich parts processed -> public/nostrich01/ ===');
console.log(rows.join('\n'));
const total = fs.readdirSync(OUT).reduce((n, f) => n + fs.statSync(path.join(OUT, f)).size, 0);
console.log(`\nTOTAL processed: ${(total / 1024 / 1024).toFixed(2)} MB`);
