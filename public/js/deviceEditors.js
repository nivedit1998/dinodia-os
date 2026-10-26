(function () {
  'use strict';
  const bindings = new WeakMap();

  // Keep a live form in place: replacing it resets native selects, text focus,
  // cursor position and unsaved values, even if the API started before editing.
  function reconcile(container, incoming) {
    const previous = new Map(Array.from(container.children)
      .filter(node => node.dataset.deviceCard).map(node => [node.dataset.deviceCard, node]));
    const retained = new Set();
    Array.from(incoming).forEach((fresh, index) => {
      const old = previous.get(fresh.dataset.deviceCard);
      const editing = old && (old.dataset.setupDirty === 'true' || old.dataset.busy === 'true'
        || old.contains(container.ownerDocument.activeElement));
      const node = editing && old.dataset.refreshAfterSave !== 'true' ? old : fresh;
      retained.add(node);
      const current = container.children[index];
      if (current !== node) container.insertBefore(node, current || null);
    });
    // Removed devices are never kept alive by an unsaved editor.
    for (const node of Array.from(container.children)) if (!retained.has(node)) node.remove();
  }

  function render(container, markup) {
    const template = container.ownerDocument.createElement('template');
    template.innerHTML = markup;
    reconcile(container, template.content.children);
  }

  function unbound(root, selector) {
    return Array.from(root.querySelectorAll(selector)).filter(node => {
      let selectors = bindings.get(node);
      if (!selectors) { selectors = new Set(); bindings.set(node, selectors); }
      if (selectors.has(selector)) return false;
      selectors.add(selector); return true;
    });
  }

  window.DinodiaDeviceEditors = { render, reconcile, unbound };
}());
