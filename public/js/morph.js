(function () {
  'use strict';
  // Update a piece of the page in place instead of throwing it away and building it again.
  // Rebuilding makes the page blink, loses the cursor in a text box, closes an open menu and jumps the scroll position.
  // Here an unchanged node is left alone, a changed one is edited, and anything the person is using is never touched.

  const KEEP_VALUE = new Set(['INPUT', 'SELECT', 'TEXTAREA']);

  function isUsing(node) {
    const doc = node.ownerDocument;
    return doc && doc.activeElement === node;
  }

  function syncAttributes(from, to) {
    for (const { name } of Array.from(from.attributes)) if (!to.hasAttribute(name)) from.removeAttribute(name);
    for (const { name, value } of Array.from(to.attributes)) if (from.getAttribute(name) !== value) from.setAttribute(name, value);
  }

  function syncFormValue(from, to) {
    if (from.tagName === 'SELECT') {
      // Options are updated in place; the chosen value stays unless the person has not touched it.
      if (isUsing(from) || from.dataset.touched === 'true') return;
      if (from.value !== to.value) from.value = to.value;
      return;
    }
    if (from.tagName === 'INPUT' && (from.type === 'checkbox' || from.type === 'radio')) {
      if (!isUsing(from) && from.dataset.touched !== 'true' && from.checked !== to.checked) from.checked = to.checked;
      return;
    }
    if (isUsing(from) || from.dataset.touched === 'true') return;
    const next = to.value !== undefined ? to.value : to.getAttribute('value') || '';
    if (from.value !== next) from.value = next;
  }

  function keyOf(node) {
    if (node.nodeType !== 1) return null;
    return node.id || node.getAttribute('data-key') || node.getAttribute('data-device-card') || node.getAttribute('data-filter-area') || null;
  }

  function patchChildren(from, to) {
    const oldNodes = Array.from(from.childNodes);
    const newNodes = Array.from(to.childNodes);
    const byKey = new Map();
    for (const node of oldNodes) { const key = keyOf(node); if (key) byKey.set(key, node); }
    const used = new Set();
    newNodes.forEach((next, index) => {
      const key = keyOf(next);
      let match = key ? byKey.get(key) : null;
      if (!match) {
        const candidate = oldNodes[index];
        if (candidate && !used.has(candidate) && !keyOf(candidate) && candidate.nodeType === next.nodeType && (next.nodeType !== 1 || candidate.tagName === next.tagName)) match = candidate;
      }
      if (match && !used.has(match)) {
        used.add(match);
        patchNode(match, next);
        const at = from.childNodes[index];
        if (at !== match) from.insertBefore(match, at || null);
      } else {
        const at = from.childNodes[index];
        from.insertBefore(next, at || null);
        used.add(next);
      }
    });
    for (const node of Array.from(from.childNodes)) if (!used.has(node)) node.remove();
  }

  function patchNode(from, to) {
    if (from.nodeType === 3 || from.nodeType === 8) { if (from.nodeValue !== to.nodeValue) from.nodeValue = to.nodeValue; return; }
    if (from.nodeType !== 1) return;
    // A node the person is editing is theirs until they finish.
    if (from.dataset && from.dataset.morphSkip === 'true') return;
    syncAttributes(from, to);
    if (KEEP_VALUE.has(from.tagName)) {
      if (from.tagName === 'SELECT') patchChildren(from, to);
      syncFormValue(from, to);
      return;
    }
    if (from.tagName === 'DETAILS') { /* open/closed belongs to the person */ if (from.hasAttribute('open') !== to.hasAttribute('open')) { if (to.hasAttribute('open')) from.setAttribute('open', ''); } }
    patchChildren(from, to);
  }

  // Replace the contents of `container` with `markup`, changing only what differs.
  function html(container, markup) {
    if (container.dataset && container.dataset.morphHtml === markup) return false;
    const template = container.ownerDocument.createElement('template');
    template.innerHTML = markup;
    patchChildren(container, template.content);
    if (container.dataset) container.dataset.morphHtml = markup;
    return true;
  }

  // Update `old` to look like `fresh` (both elements), keeping the person's place.
  function patch(old, fresh) { patchNode(old, fresh); }

  function trackTouched(root) {
    const mark = (event) => { const target = event.target; if (target && KEEP_VALUE.has(target.tagName) && event.isTrusted !== false) target.dataset.touched = 'true'; };
    root.addEventListener('input', mark, true);
    root.addEventListener('change', mark, true);
  }

  window.DinodiaMorph = { html, patch, patchChildren, trackTouched };
  if (typeof document !== 'undefined' && document.addEventListener) trackTouched(document);
}());
