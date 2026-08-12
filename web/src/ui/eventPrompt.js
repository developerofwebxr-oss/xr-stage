// ui/eventPrompt.js — the event-transition prompt. Shown once per new event to embodied
// non-holders + signed-in ghosts when a new event starts. Container only; actions injected.
//
//   createEventPrompt({ onGetTicket, onWelcomeZap, onContinueGhost })
//     open({ title, speaker }) · close() · isOpen()

const $ = (id) => document.getElementById(id);
const esc = (s) => { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML; };

export function createEventPrompt({ onGetTicket, onWelcomeZap, onContinueGhost } = {}) {
  const el = {
    root: $('event-prompt'), headline: $('ep-headline'),
    ticket: $('ep-ticket'), zap: $('ep-zap'), ghost: $('ep-ghost'),
  };
  function open({ title, speaker } = {}) {
    el.headline.innerHTML = `Now on stage: <b>${esc(title)}</b>${speaker ? ` — ${esc(speaker)}` : ''}`;
    el.root.hidden = false;
  }
  function close() { el.root.hidden = true; }

  el.ticket.addEventListener('click', () => { close(); onGetTicket && onGetTicket(); });        // → tier chooser (this event)
  el.zap.addEventListener('click', () => { close(); onWelcomeZap && onWelcomeZap(); });          // one-tap zap (everyone) — no status change
  el.ghost.addEventListener('click', () => { close(); onContinueGhost && onContinueGhost(); });  // dismiss → lapse to ghost
  el.root.addEventListener('click', (e) => { if (e.target === el.root) { close(); onContinueGhost && onContinueGhost(); } }); // backdrop = dismiss

  return { open, close, isOpen: () => !el.root.hidden };
}
