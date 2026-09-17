import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { packageName, planRelease, readRegistry, registryUrl, stampRelease } from './prepare-release.mjs';

const older = 'a'.repeat(40);
const current = 'b'.repeat(40);
const newer = 'c'.repeat(40);
function pkg(version = '0.2.1') {
  return { name: packageName, version, repository: { url: 'https://github.com/TwinForceIT/homebridge-miot.git' },
    publishConfig: { registry: registryUrl, access: 'public' } };
}
function registry(versions = { '0.2.1': {} }) { return { name: packageName, versions }; }
function ancestor(a, b) { return [older, current, newer].indexOf(a) < [older, current, newer].indexOf(b); }

// Existing manually published packages have no gitHead; the first automated release establishes it.
test('bootstraps from the current published version, without requiring historical metadata', () => {
  assert.deepEqual(planRelease(pkg(), registry(), current, ancestor), {
    publish: true, version: '0.2.2', reason: 'New main commit; publish a public stable release.',
  });
});

test('compares versions numerically, ignores prereleases, and does not reuse an older latest tag', () => {
  const history = registry({ '0.2.9': {}, '0.2.10': {}, '0.3.0-beta.1': {} });
  history['dist-tags'] = { latest: '0.2.9', next: '0.3.0-beta.1' };
  assert.equal(planRelease(pkg(), history, current, ancestor).version, '0.2.11');
});

test('allows an explicitly higher minor or major release and otherwise increments patch', () => {
  assert.equal(planRelease(pkg('0.3.0'), registry(), current, ancestor).version, '0.3.0');
  assert.equal(planRelease(pkg('1.0.0'), registry(), current, ancestor).version, '1.0.0');
  assert.equal(planRelease(pkg('0.2.0'), registry(), current, ancestor).version, '0.2.2');
});

test('rerunning an already published commit is idempotent, including after subsequent releases', () => {
  const history = registry({
    '0.2.2': { 'x-homebridge-miot-release': { commit: current, runId: '123' } },
    '0.2.3': { 'x-homebridge-miot-release': { commit: newer, runId: '124' } },
  });
  const plan = planRelease(pkg(), history, current, () => { throw new Error('No ancestry check needed'); });
  assert.equal(plan.publish, false);
  assert.equal(plan.version, '0.2.2');
});

test('does not publish an older queued push after its descendant was released', () => {
  const plan = planRelease(pkg(), registry({ '0.2.2': { gitHead: newer } }), current, ancestor);
  assert.equal(plan.publish, false);
  assert.match(plan.reason, /newer descendant/);
});

test('publishes a descendant and retains the source boundary across manual releases', () => {
  const history = registry({ '0.2.2': { gitHead: older }, '0.2.3': {} });
  assert.equal(planRelease(pkg(), history, current, ancestor).version, '0.2.4');
});

test('refuses divergent or unreadable history rather than promoting unrelated source', () => {
  const history = registry({ '0.2.2': { gitHead: older } });
  assert.throws(() => planRelease(pkg(), history, current, () => false), /history diverged/);
  assert.throws(() => planRelease(pkg(), history, current, () => { throw new Error('History missing'); }), /History missing/);
});

test('refuses unexpected package configuration and invalid registry metadata', () => {
  for (const version of ['0.3.0-beta.1', 'v0.3.0', '01.2.3', '9007199254740992.0.0']) {
    assert.throws(() => planRelease(pkg(version), registry(), current, ancestor), /stable version/);
  }
  assert.throws(() => planRelease({ ...pkg(), name: 'other-package' }, registry(), current, ancestor));
  assert.throws(() => planRelease(pkg(), { name: 'other-package', versions: {} }, current, ancestor));
  assert.throws(() => planRelease(pkg(), registry({}), current, ancestor), /stable release/);
  assert.throws(() => planRelease(pkg(), registry({ '0.2.2': { gitHead: 'bad-ref' } }), current, ancestor), /Invalid source/);
  assert.throws(() => planRelease(pkg(), registry(), 'refs/heads/main', ancestor));
});

test('registry failures abort instead of guessing the next version', async () => {
  await assert.rejects(readRegistry(async () => ({ ok: false, status: 503 })), /HTTP 503/);
  await assert.rejects(readRegistry(async () => { throw new Error('Network unavailable'); }), /Network unavailable/);
  const history = registry();
  assert.equal(await readRegistry(async (url, options) => {
    const requestUrl = new URL(url);
    assert.equal(requestUrl.origin, registryUrl);
    assert.equal(requestUrl.pathname, '/%40twinforce%2Fhomebridge-miot');
    assert.match(requestUrl.searchParams.get('release-check'), /^[a-f0-9-]{36}$/);
    assert.equal(options.headers.Accept, 'application/json');
    assert.ok(options.signal instanceof AbortSignal);
    return { ok: true, json: async () => history };
  }), history);
});

test('stamps the package and lockfile consistently and persists metadata needed by a retry', t => {
  const directory = mkdtempSync(join(tmpdir(), 'miot-release-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, 'package.json'), JSON.stringify(pkg()));
  const dependency = { version: '1.2.3', integrity: 'preserved' };
  writeFileSync(join(directory, 'package-lock.json'), JSON.stringify({ name: packageName, version: '0.2.1',
    packages: { '': { name: packageName, version: '0.2.1' }, 'node_modules/example': dependency } }));
  stampRelease(directory, '0.2.2', current, '123');
  const stamped = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(join(directory, 'package-lock.json'), 'utf8'));
  assert.equal(stamped.version, '0.2.2');
  assert.equal(lock.version, stamped.version);
  assert.equal(lock.packages[''].version, stamped.version);
  assert.deepEqual(lock.packages['node_modules/example'], dependency);
  assert.equal(stamped.gitHead, current);
  assert.deepEqual(stamped['x-homebridge-miot-release'], { commit: current, runId: '123' });
  assert.equal(planRelease(pkg(), registry({ '0.2.2': stamped }), current, ancestor).publish, false);
});

test('consecutive release checks bypass previously cached registry responses', async () => {
  const urls = [];
  const registryFetch = async url => {
    urls.push(url);
    return { ok: true, json: async () => registry() };
  };
  await readRegistry(registryFetch);
  await readRegistry(registryFetch);
  assert.equal(urls.length, 2);
  assert.notEqual(urls[0], urls[1]);
});
