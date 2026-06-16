// ui/joystick.js — a tiny, self-contained on-screen movement stick for touch.
//
// Hand-rolled (no dependency): a draggable thumb inside a fixed ring. The drag
// offset, normalised to [-1, 1] and clamped to the ring radius, is reported via
// onMove(strafe, forward) where forward>0 means "walk the way you're facing".
// main.js feeds that straight into locomotion.setMoveInput, so movement uses the
// exact same path as desktop WASD — magnitude gives analog speed.
//
// Mobile-only: main.js decides whether to mount it (feature detection), so this
// module just wires the element it's handed.

export function createJoystick(rootEl, { onMove }) {
  const thumb = rootEl.querySelector('#joystick-thumb');
  rootEl.hidden = false;

  let activeId = null;
  let cx = 0, cy = 0;        // ring centre in client coords (captured on touch)
  const radius = rootEl.clientWidth / 2;

  function setThumb(dx, dy) {
    thumb.style.transform = `translate(${dx}px, ${dy}px)`;
  }

  function report(dx, dy) {
    // dy is screen-down-positive; forward is the opposite, so negate it.
    onMove(dx / radius, -dy / radius);
  }

  rootEl.addEventListener('pointerdown', (e) => {
    activeId = e.pointerId;
    const r = rootEl.getBoundingClientRect();
    cx = r.left + r.width / 2;
    cy = r.top + r.height / 2;
    rootEl.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  rootEl.addEventListener('pointermove', (e) => {
    if (e.pointerId !== activeId) return;
    let dx = e.clientX - cx;
    let dy = e.clientY - cy;
    // Clamp the thumb (and thus the reported magnitude) to the ring radius.
    const dist = Math.hypot(dx, dy);
    if (dist > radius) { dx = (dx / dist) * radius; dy = (dy / dist) * radius; }
    setThumb(dx, dy);
    report(dx, dy);
  });

  function end(e) {
    if (e.pointerId !== activeId) return;
    activeId = null;
    setThumb(0, 0);
    onMove(0, 0); // release → stop moving
  }
  rootEl.addEventListener('pointerup', end);
  rootEl.addEventListener('pointercancel', end);
}
