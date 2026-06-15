import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// Vite config for the spatial-stage client.
//
// Mirrors the Sats Arena game's config conventions (basicSsl + host:true) because
// WebXR has two hard requirements during development:
//   1. Secure context — browsers refuse immersive-vr/immersive-ar on plain HTTP.
//      basicSsl mints a self-signed cert so `npm run dev` is https://localhost.
//      You'll see a one-time "proceed anyway" warning; the Quest browser needs
//      you to accept it too (visit the LAN URL once and tap Advanced → Proceed).
//   2. LAN reachability — host:true exposes the dev server on your local network
//      so a Quest headset / phone on the same WiFi can load the same URL.
export default defineConfig(() => ({
  // Relative base so a static `dist/` works whether it's served from the domain
  // root or a GitHub Pages project subpath (e.g. /sats-stage/). Single-page app,
  // so relative asset URLs resolve correctly either way.
  base: './',

  plugins: [basicSsl()],

  server: {
    https: true,
    host: true,
  },
}));
