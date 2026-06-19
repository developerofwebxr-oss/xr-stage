// identity/keyface.js — a deterministic "keyface" drawn from a pubkey: a mirrored
// identicon over a dark Live-Console base. Used when an identity has no profile
// picture (always, in the mock). Pure canvas (no THREE) — callers wrap it in a
// texture (avatars) or a data URL (HUD chip). REAL: replaced by the profile image
// when getProfile().picture is set.
export function drawKeyface(pubkey, size = 128) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const bytes = pubkey.match(/../g).map((h) => parseInt(h, 16));

  // Dark base tuned to the panel colour.
  g.fillStyle = '#0e1119';
  g.fillRect(0, 0, size, size);

  // Accent hue from the key; a 5×5 grid mirrored left↔right so it reads as a face.
  g.fillStyle = `hsl(${Math.round((bytes[0] / 255) * 360)} 70% 62%)`;
  const grid = 5;
  const pad = size * 0.14;
  const cell = (size - pad * 2) / grid;
  for (let row = 0; row < grid; row++) {
    for (let cx = 0; cx < 3; cx++) {            // left half + centre column
      const i = row * 3 + cx;
      if (!((bytes[i % bytes.length] >> (i % 8)) & 1)) continue;
      for (const col of [cx, grid - 1 - cx]) {  // mirror to the right
        g.fillRect(Math.floor(pad + col * cell), Math.floor(pad + row * cell), Math.ceil(cell), Math.ceil(cell));
      }
    }
  }
  return c;
}
