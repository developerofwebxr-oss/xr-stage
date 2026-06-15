// state/stageState.js — the single shared-room state object + a tiny pub/sub.
//
// SEAM (intentionally larger than this phase needs). Right now it only tracks the
// local role and the live participant counts. It is the object that later prompts
// extend with: who currently holds the stage, the active stage skin, zap totals,
// sponsor slot assignments, etc. Everything that needs to be the SAME for everyone
// in the room belongs here and will be synced over the LiveKit data channel —
// the same pipe presence.js already proves out.
//
// Usage:
//   import { stageState, onStateChange, setState } from './state/stageState.js';
//   setState({ speakerCount: 2 });            // mutate + notify
//   onStateChange((s) => renderHud(s));        // subscribe

export const stageState = {
  // Local role for this client ('speaker' | 'listener'). Set from config at boot.
  role: 'listener',

  // Live counts, updated by the voice + presence layers.
  participantCount: 1, // includes us
  speakerCount: 0,

  // --- Seams for later prompts (declared, not yet driven) ---------------------
  // stageHolderId: null,   // identity that currently "owns" the stage
  // skin: 'default',       // generated stage skin id
  // zaps: 0,               // running sats total
};

const listeners = new Set();

// Merge a partial update into stageState and notify subscribers.
export function setState(patch) {
  Object.assign(stageState, patch);
  for (const fn of listeners) fn(stageState);
}

// Subscribe to changes. Returns an unsubscribe fn.
export function onStateChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
