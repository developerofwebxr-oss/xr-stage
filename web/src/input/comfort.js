// input/comfort.js — the comfort layer of the Controller & Input Standard.
//
// Per the standard, ALL comfort aids are OFF by default and opt-in via the pause
// menu (VR X / desktop Esc·M / mobile ☰), then PERSISTED to localStorage. Movement
// speed is NOT a comfort toggle — walk 1.4 / run 2.8 are fixed (see locomotion.js).
// Rationale: don't nanny. Full, unrestricted movement is the default; these exist
// only for the users who want them.
//
//   vignette  — tunnelling vignette during movement (motion-sickness aid)
//   snapTurn  — snap (stepped) turning instead of the default smooth turn
//   haptics   — controller pulses on fire / grab / land
//
// One tiny pub-sub so the menu (writer) and locomotion/main (readers) stay in sync
// without importing each other.

const KEY = 'xrstage:comfort';
const DEFAULTS = { vignette: false, snapTurn: false, haptics: false };

function load() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; }
  catch { return { ...DEFAULTS }; }
}

let state = load();
const subs = new Set();

export const comfort = {
  KEYS: Object.keys(DEFAULTS),
  get: (k) => !!state[k],
  all: () => ({ ...state }),
  set(k, v) {
    if (!(k in DEFAULTS)) return;
    state[k] = !!v;
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* private mode */ }
    for (const fn of subs) fn(k, state[k]);
  },
  // fn(key, value) on every change; returns an unsubscribe.
  onChange(fn) { subs.add(fn); return () => subs.delete(fn); },
};
