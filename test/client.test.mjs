import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

async function loadClientModule() {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
  let registered;
  const reactStub = {
    createElement: () => null,
    useState: () => [null, () => {}],
    useCallback: (fn) => fn,
    useEffect: () => {},
  };
  const window = {
    __ModuleLoader__: {
      load({ id, factory }) {
        registered = { id, exports: factory((name) => (name === 'react' ? reactStub : ({}))) };
      },
    },
  };
  const run = new Function('window', source);
  run(window);
  return registered;
}

test('client module registers the command card and the sidebar page', async () => {
  const loaded = await loadClientModule();
  assert.equal(loaded.id, 'dsh-remote-relay');
  assert.equal(typeof loaded.exports.apply, 'function');
  assert.deepEqual(loaded.exports.inject, ['slots']);

  const registrations = [];
  const ctx = {
    slots: {
      inject(name, callback) {
        callback(name);
        return () => {};
      },
      register(options, component) {
        registrations.push({ options, component });
      },
    },
  };
  const dispose = loaded.exports.apply(ctx);
  assert.equal(typeof dispose, 'function');

  const bySlot = (name) => registrations.find((r) => r.options.name === name);

  const command = bySlot('conversation.chat.commandview');
  assert.equal(command.options.key, 'relay');
  assert.equal(typeof command.component, 'function');

  const panel = bySlot('sidebar.panellist');
  assert.equal(panel.options.id, 'remote-relay');
  assert.equal(panel.options.label, '远程');
  assert.equal(typeof panel.component, 'function');

  const page = bySlot('main');
  assert.equal(page.options.key, 'remote-relay');
  assert.equal(typeof page.component, 'function');
});
