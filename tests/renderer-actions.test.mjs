import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../src/renderer.js', import.meta.url), 'utf8');

test('failed pin save restores the normalized list object', async () => {
  const scope = {
    allPrompts: [{ name: 'A', content: 'body', isPinned: false }],
    renderAll() {}, showToast() {},
    async saveData() {
      scope.allPrompts = scope.allPrompts.map(item => ({ ...item }));
      return false;
    },
  };
  vm.createContext(scope);
  const start = source.indexOf('  async function togglePinAtIndex(');
  const end = source.indexOf('  async function copyPromptContentAtIndex(', start);
  vm.runInContext(source.slice(start, end), scope);
  assert.equal(await scope.togglePinAtIndex(0), false);
  assert.equal(scope.allPrompts[0].isPinned, false);
});

function setup(copied = true) {
  const calls = [];
  const scope = {
    allPrompts: [{ name: 'A', content: 'body' }], useInFlight: false, previewUse: null, selectedIndex: null,
    setUseInFlight(value) { scope.useInFlight = value; },
    async copyText(text) { calls.push(['copy', text]); return copied; },
    async copyPromptForUse(text) { calls.push(['paste', text]); return { copied: true, pasted: true }; },
    showToast() {}, flashCard() {}, markPromptUsed() { calls.push(['used']); }, async saveData() { calls.push(['save']); },
  };
  vm.createContext(scope);
  const start = source.indexOf('  async function usePromptAtIndex(');
  const end = source.indexOf('  function updateSidebarAndDropdown()', start);
  vm.runInContext(source.slice(start, end), scope);
  return { calls, scope };
}

test('copy-only action never invokes automatic paste', async () => {
  const { calls, scope } = setup();
  const result = await scope.usePromptAtIndex(0, null, { copyOnly: true });
  assert.equal(result.pasted, false);
  assert.deepEqual(calls, [['copy', 'body'], ['used'], ['save']]);
  assert.equal(scope.useInFlight, false);
});

test('regular action still pastes and failed copy does not record usage', async () => {
  const normal = setup();
  await normal.scope.usePromptAtIndex(0);
  assert.deepEqual(normal.calls, [['paste', 'body'], ['used'], ['save']]);
  const failed = setup(false);
  assert.equal((await failed.scope.usePromptAtIndex(0, null, { copyOnly: true })).copied, false);
  assert.deepEqual(failed.calls, [['copy', 'body']]);
  assert.equal(failed.scope.useInFlight, false);
});

test('card and preview clicks pass Shift state into the action', async () => {
  for (const shiftKey of [true, false]) {
    const calls = [];
    const scope = {
      dismissSystemMenuForCallPath() {}, selectCard() {},
      item: { originalIndex: 0 }, selectedIndex: 0, allPrompts: [{}],
      card: { focus() {} }, previewUse: {},
      document: { querySelector() { return scope.card; } },
      usePromptAtIndex(index, card, options) { calls.push({ index, card, copyOnly: options.copyOnly }); },
    };
    scope.card.addEventListener = (name, callback) => { scope.callback = callback; };
    vm.createContext(scope);
    const start = source.indexOf('      card.addEventListener("click",');
    const end = source.indexOf('      // Arrow navigation', start);
    vm.runInContext(source.slice(start, end), scope);
    await scope.callback({ shiftKey });
    const preview = source.indexOf('    previewUse.onclick =');
    const previewEnd = source.indexOf('    };', preview) + 6;
    vm.runInContext(source.slice(preview, previewEnd), scope);
    await scope.previewUse.onclick({ shiftKey });
    assert.equal(calls.length, 2);
    assert.ok(calls.every(call => call.copyOnly === shiftKey));
  }
});
