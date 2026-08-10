// session/session.js — client for the cross-device "log in on your headset" pairing.
//
// Mint side (signed-in phone/desktop): mintCode(profile) → { code, expiresAt }.
// Redeem side (headset / any device):  redeemCode(code)   → PUBLIC profile.
//
// Both hit the SAME backend as the LiveKit token server, at config.serverBase (derived
// from VITE_TOKEN_URL — no new env var). No secrets ever leave the origin device: we send
// only the public identity profile up, and get the public profile back. Errors are turned
// into short, user-facing messages (the UI shows them verbatim).

import { config } from '../config.js';

const NOT_CONFIGURED = 'Login server not configured';

function endpoint(path) {
  const base = config.serverBase;
  if (!base) throw new Error(NOT_CONFIGURED);
  return `${base}${path}`;
}

async function postJSON(path, body) {
  let res;
  try {
    res = await fetch(endpoint(path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    const e = new Error('Network error — check your connection'); e.cause = err; throw e;
  }
  return res;
}

// Mint a code bound to the caller's PUBLIC identity (pubkey + display fields ONLY — never
// npub-less secrets, never keys). Returns { code, expiresAt }.
export async function mintCode(identity) {
  if (!identity?.pubkey) throw new Error('Sign in first');
  const res = await postJSON('/session-code', {
    pubkey: identity.pubkey,
    name: identity.name,
    picture: identity.picture || undefined,
    nip05: identity.nip05 || undefined,
    lud16: identity.lud16 || undefined,
  });
  if (!res.ok) throw new Error('Could not create a code — try again');
  const { code, expiresAt } = await res.json().catch(() => ({}));
  if (!code) throw new Error('Could not create a code — try again');
  return { code, expiresAt };
}

// Redeem a 6-digit code → the stored PUBLIC profile. 404/410/400 all read as "invalid or
// expired" to the user; 429 is the rate-limit backstop.
export async function redeemCode(code) {
  const clean = String(code || '').replace(/\D/g, '');
  if (clean.length !== 6) throw new Error('Enter the 6-digit code');
  const res = await postJSON('/session-redeem', { code: clean });
  if (res.status === 429) throw new Error('Too many attempts — wait a minute');
  if (!res.ok) throw new Error('Code invalid or expired');
  const profile = await res.json().catch(() => null);
  if (!profile?.pubkey) throw new Error('Code invalid or expired');
  return profile;
}
