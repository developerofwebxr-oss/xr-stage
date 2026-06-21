import { drawKeyface } from '../identity/keyface.js';

// ui/profileCard.js — the profile card as a FIXED DOM panel (flat/mobile): same
// size/position regardless of how far the avatar is, so it's always readable. (2.2
// floated it in-world, which was tiny on distant avatars.)
//
// This is the CONTAINER only. The data + action handlers are passed in and kept
// separate, so the deferred VR variant — a small camera-anchored in-world card —
// can reuse the exact same handlers without a rewrite.
//
//   createProfileCard({ onVisit, onFollow, onZap, onClose })
//     open(profile, { following })   profile = identity-service object
//     setFollowing(bool)             update the Follow ⇄ Following label
//     close() · isOpen() · profile()
//
// Buttons are DOM, so clicks are handled here (no raycast hit-testing) and never
// fall through to the canvas. Data comes only from the passed-in identity profile.

const $ = (id) => document.getElementById(id);
const shortNpub = (npub) => (npub.length > 24 ? `${npub.slice(0, 16)}…${npub.slice(-6)}` : npub);

export function createProfileCard({ onVisit, onFollow, onZap, onClose } = {}) {
  const el = {
    card: $('profile-card'),
    close: $('pc-close'),
    face: $('pc-face'),
    name: $('pc-name'),
    npub: $('pc-npub'),
    nip05: $('pc-nip05'),
    visit: $('pc-visit'),
    follow: $('pc-follow'),
    zap: $('pc-zap'),
  };
  let current = null; // the identity profile the card is showing

  // Buttons call the SAME named handlers from 2.2 (Follow = mock toggle, Zap = stub).
  el.close.addEventListener('click', () => onClose && onClose());
  el.visit.addEventListener('click', () => current && onVisit && onVisit(current));
  el.follow.addEventListener('click', () => current && onFollow && onFollow(current));
  el.zap.addEventListener('click', () => current && onZap && onZap(current));

  function open(profile, { following = false } = {}) {
    current = profile;
    // keyface (REAL: profile.picture when present)
    el.face.src = profile.picture || drawKeyface(profile.pubkey, 96).toDataURL();
    el.name.textContent = profile.name;
    el.npub.textContent = shortNpub(profile.npub);
    el.nip05.textContent = profile.nip05 || '';
    setFollowing(following);
    el.card.hidden = false;
  }
  function setFollowing(on) {
    el.follow.textContent = on ? 'Following' : 'Follow';
    el.follow.classList.toggle('on', !!on);
  }
  function close() {
    current = null;
    el.card.hidden = true;
  }

  return { open, close, setFollowing, isOpen: () => !el.card.hidden, profile: () => current };
}
