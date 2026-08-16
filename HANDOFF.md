# xr-stage — state brief (2026-08-16)

**What this is:** A WebXR "spatial stage / live venue" that opens from ONE URL and runs on desktop, mobile, Quest VR and AR passthrough — Three.js + Vite static client, plus a tiny backend that mints LiveKit voice tokens. Includes Nostrich Park: a paid zone with a procedural flock, a roller coaster, and paid bird-feeding. Money is mock credits (no real Lightning wallet).

**Live URLs / deploys:**
- Client: `https://developerofwebxr-oss.github.io/xr-stage/` — GitHub Pages, auto-deploys on push to `main` (Actions → `.github/workflows/deploy.yml`, builds `web/`).
- Backend: Railway service `xr-stage-production` (Node/Express, `server/`) — mints LiveKit tokens at `/token`.
- Voice: LiveKit Cloud.

**Status:**
Works: four-mode room + voice + presence; Nostrich Park (paid entry, flock of 8 primitive ostriches, coaster with a super-peak + inversion loop, feed-a-bird ⚡33 with 6 deterministic personality reactions, all broadcast); real owner GLBs load (entrance gate, coaster carts); the "Psycho" — one real cyber-nostrich assembled from decimated scan parts with a 4-head expression state machine + a custom fed-escalation; in-world VR/AR menu.
Whacky / needs on-device (headless can't enter VR): the menu-open X-fix, body fresnel shell, feed reactions, the coaster VR ride + inversion comfort, and the new park wall-collision are all verified in code/headless only. The **Psycho's legs read stumpy** — the raw scans bake a display-plinth at the base (cosmetic; body/neck/head are correct).

**Changed this session (4.12–4.17):**
- Fixed owner GLBs not loading (absolute→`document.baseURI` asset paths); real entrance + carts render.
- Coaster: stabilized parallel-transport frames (no rider flips, ~4.6° max), added a super-peak + inversion loop, higher/faster profile, glowing RIDE post + seat-snap.
- Feed-the-Nostriches paid interaction (6 reactions) + effects.
- Built a gltf-transform decimation pipeline (`web/scripts/process-nostrich01.mjs`); assembled the Psycho and re-derived its orientation (a backwards-body bug had twisted it).
- Fixed the in-world menu never appearing in VR (stale head pose read at input time → deferred to a render frame) and the orphaned "sky panel."
- Park: removed leftover primitive gate columns, made the perimeter SOLID (no building had wall collision before — general gap), moved it onto the venue's arc with a clear gap from Networking, re-routed the coaster's park side.

**Next steps:**
1. On-device Quest pass: X opens the menu 1.2 m ahead + no sky panels; feed all 6 reactions + the Psycho; ride the coaster (inversion comfort); confirm the park fence blocks except at the arch.
2. Polish the Psycho's legs (trim the baked display-plinth in the pipeline, or adjust the leg fit).
3. Re-test AR passthrough (park shell-off; wall collision is disabled in AR by design).

**Open decisions / blockers:** Whether the Psycho's stumpy legs are acceptable for now or need a pipeline plinth-trim. Otherwise unblocked.

**Infra notes:** Railway service `xr-stage-production` (LiveKit token minting). LiveKit Cloud for voice. GitHub Pages via Actions from `main`. No Lightning wallet — economy is mock credits. Secrets live only in Railway/Actions Variables, never in the repo.
