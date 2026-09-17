import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MatterIdentityStore } from '../src/matter/identity-store.js';

test('external Matter identity store survives restart without storing credentials or live state', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'miot-identity-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new MatterIdentityStore(directory);
  assert.equal((await store.load()).size, 0);
  const identity = { UUID: 'persistent-uuid', context: { identity: 'did:123', model: 'xiaomi.vacuum.b112', token: 'secret', battery: 99 } };
  await store.save(new Map([[identity.UUID, identity]]));
  const restored = await new MatterIdentityStore(directory).load();
  assert.deepEqual([...restored.values()], [{ UUID: identity.UUID, context: { identity: 'did:123', model: identity.context.model } }]);
  const path = join(directory, 'xiaomi-miot-matter-identities.json');
  assert.ok(!(await readFile(path, 'utf8')).includes('secret'));
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test('invalid saved Matter identities fail closed instead of silently replacing paired devices', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'miot-identity-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'xiaomi-miot-matter-identities.json');
  const store = new MatterIdentityStore(directory);
  for (const text of ['{', '{"version":2,"devices":[]}', '{"version":1,"devices":[{"UUID":"x","context":{}}]}']) {
    await writeFile(path, text);
    await assert.rejects(store.load(), /Restore .* from a Homebridge backup/);
    assert.equal(await readFile(path, 'utf8'), text);
  }
});
