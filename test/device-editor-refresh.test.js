const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function fixture() {
  const script = fs.readFileSync(path.join(__dirname, '../public/js/deviceEditors.js'), 'utf8');
  const context = { window: {} }; vm.runInNewContext(script, context);
  const document = { activeElement: null };
  const card = id => ({ dataset: { deviceCard: id }, children: [], contains(node) { return node === this || this.children.includes(node); }, remove() { const i = container.children.indexOf(this); if (i >= 0) container.children.splice(i, 1); } });
  const container = { ownerDocument: document, children: [], insertBefore(node, before) {
    const old = this.children.indexOf(node); if (old >= 0) this.children.splice(old, 1);
    const i = before ? this.children.indexOf(before) : this.children.length; this.children.splice(i, 0, node);
  } };
  return { api: context.window.DinodiaDeviceEditors, document, card, container };
}

test('a refresh arriving after focus changed preserves the actual editor node and selection', () => {
  const f = fixture(), edited = f.card('new-valve'), other = f.card('existing-valve');
  const input = { value: 'Room 2 Radiator', selectionStart: 8 }; edited.children.push(input);
  f.container.children = [edited, other]; f.document.activeElement = input;
  const freshOther = f.card('existing-valve');
  f.api.reconcile(f.container, [f.card('new-valve'), freshOther]);
  assert.equal(f.container.children[0], edited);
  assert.equal(f.container.children[0].children[0], input);
  assert.equal(input.value, 'Room 2 Radiator'); assert.equal(input.selectionStart, 8);
  assert.equal(f.container.children[1], freshOther, 'unrelated devices still refresh');
});

test('unsaved assignment survives blur, refresh and a failed save; successful save releases it', () => {
  const f = fixture(), edited = f.card('valve'); edited.dataset.setupDirty = 'true';
  f.container.children = [edited];
  f.api.reconcile(f.container, [f.card('valve')]); assert.equal(f.container.children[0], edited);
  edited.dataset.busy = 'true'; f.api.reconcile(f.container, [f.card('valve')]);
  delete edited.dataset.busy; f.api.reconcile(f.container, [f.card('valve')]);
  assert.equal(f.container.children[0], edited);
  edited.dataset.refreshAfterSave = 'true'; const saved = f.card('valve');
  f.api.reconcile(f.container, [saved]); assert.equal(f.container.children[0], saved);
});

test('a removed or no-longer-authorized device disappears even if its form is dirty', () => {
  const f = fixture(), edited = f.card('valve'); edited.dataset.setupDirty = 'true';
  f.container.children = [edited]; f.api.reconcile(f.container, []);
  assert.equal(f.container.children.length, 0);
});

test('preserved setup elements get each listener once across repeated refreshes', () => {
  const f = fixture(), node = {}; const root = { querySelectorAll: () => [node] };
  assert.equal(f.api.unbound(root, '[data-save-device]').length, 1);
  assert.equal(f.api.unbound(root, '[data-save-device]').length, 0);
  assert.equal(f.api.unbound(root, '[data-device-setup]').length, 1);
});
