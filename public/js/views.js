(function () {
  'use strict';
  // The dashboard shows one job at a time: Add devices, Devices, Rooms or Hub. Switching is instant and never scrolls anywhere but the top.
  const NAMES = ['add', 'devices', 'rooms', 'hub'];
  function current() { return document.body.dataset.view || 'add'; }
  function show(name, { remember = true } = {}) {
    if (!NAMES.includes(name)) name = 'add';
    const changed = document.body.dataset.view !== name;
    document.body.dataset.view = name;
    document.querySelectorAll('[data-view-link]').forEach((link) => {
      const active = link.dataset.viewLink === name;
      link.classList.toggle('active', active);
      if (active) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
    });
    if (remember) { try { history.replaceState(null, '', `#${name}`); } catch { /* the address bar is optional */ } }
    if (changed && typeof window.scrollTo === 'function') window.scrollTo(0, 0);
  }
  document.addEventListener('click', (event) => {
    const link = event.target.closest?.('[data-view-link]');
    if (!link) return;
    event.preventDefault();
    show(link.dataset.viewLink);
  });
  window.addEventListener('hashchange', () => { const name = location.hash.slice(1); if (NAMES.includes(name)) show(name, { remember: false }); });
  const start = NAMES.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'add';
  show(start, { remember: false });
  window.DinodiaViews = { show, current };
}());
