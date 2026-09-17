import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const packageName = '@twinforce/homebridge-miot';
export const registryUrl = 'https://registry.npmjs.org';
const repository = 'TwinForceIT/homebridge-miot';
const commitPattern = /^[a-f0-9]{40}$/;

function stableVersion(version) {
  if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) return undefined;
  const parts = version.split('.').map(Number);
  return parts.every(Number.isSafeInteger) ? parts : undefined;
}

function compareVersions(left, right) {
  const a = stableVersion(left);
  const b = stableVersion(right);
  assert.ok(a && b, 'Release versions must be stable major.minor.patch versions.');
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

function sourceCommit(manifest) {
  const commit = manifest['x-homebridge-miot-release']?.commit ?? manifest.gitHead;
  if (commit === undefined) return undefined; // Older manually published releases have no source metadata.
  assert.match(commit, commitPattern, 'Invalid source commit in published npm metadata.');
  return commit;
}

/** Select a release without modifying files or publishing. The workflow serializes callers. */
export function planRelease(pkg, metadata, commit, isAncestor) {
  assert.equal(pkg.name, packageName);
  assert.equal(pkg.publishConfig?.registry, registryUrl);
  assert.equal(pkg.publishConfig?.access, 'public');
  assert.equal(pkg.repository?.url, `https://github.com/${repository}.git`);
  assert.match(commit, commitPattern);
  assert.ok(stableVersion(pkg.version), 'Set a stable version in package.json; prereleases are not published from main.');
  assert.equal(metadata.name, packageName, 'Unexpected package returned by npm.');
  assert.ok(metadata.versions && typeof metadata.versions === 'object' && !Array.isArray(metadata.versions), 'Missing npm versions.');
  const versions = Object.keys(metadata.versions).filter(version => stableVersion(version)).sort(compareVersions);
  assert.ok(versions.length, 'Expected the existing public package to contain a stable release.');

  const published = versions.find(version => sourceCommit(metadata.versions[version]) === commit);
  if (published) return { publish: false, version: published, reason: 'This commit is already published.' };

  // Old/manual releases may omit gitHead. Retain the newest known source boundary.
  const tracked = versions.findLast(version => sourceCommit(metadata.versions[version]));
  if (tracked) {
    const previousCommit = sourceCommit(metadata.versions[tracked]);
    if (isAncestor(commit, previousCommit)) {
      return { publish: false, version: tracked, reason: 'A newer descendant of this commit is already published.' };
    }
    assert.ok(isAncestor(previousCommit, commit), 'Release history diverged. Refusing to replace latest with an unrelated source commit.');
  }

  const highest = versions.at(-1);
  let version = pkg.version;
  if (compareVersions(version, highest) <= 0) {
    const parts = stableVersion(highest);
    assert.ok(Number.isSafeInteger(parts[2] + 1), 'Patch version overflow.');
    parts[2]++;
    version = parts.join('.');
  }
  return { publish: true, version, reason: 'New main commit; publish a public stable release.' };
}

export async function readRegistry(fetchRegistry = fetch) {
  // A fresh URL also bypasses caches that ignore request Cache-Control headers.
  const url = new URL(`${registryUrl}/${encodeURIComponent(packageName)}`);
  url.searchParams.set('release-check', randomUUID());
  const response = await fetchRegistry(url.href, {
    headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Cannot read npm release history (HTTP ${response.status}); refusing to guess a version.`);
  return response.json();
}

export function stampRelease(directory, version, commit, runId) {
  const packagePath = resolve(directory, 'package.json');
  const lockPath = resolve(directory, 'package-lock.json');
  const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  assert.equal(lock.name, packageName);
  assert.equal(lock.packages?.['']?.name, packageName);
  pkg.version = lock.version = lock.packages[''].version = version;
  // Explicit metadata makes retries idempotent even when npm omits its own gitHead.
  pkg.gitHead = commit;
  pkg['x-homebridge-miot-release'] = { commit, runId };
  writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
  writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
}

function isGitAncestor(ancestor, descendant) {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], { stdio: 'pipe' });
    return true;
  } catch (error) {
    if (error.status === 1) return false;
    throw new Error('Cannot verify published source history. Use a full checkout and do not rewrite main.', { cause: error });
  }
}

async function main() {
  assert.equal(process.env.GITHUB_REPOSITORY, repository);
  assert.equal(process.env.GITHUB_REF, 'refs/heads/main', 'Publishing is only allowed from main.');
  assert.ok(['push', 'workflow_dispatch'].includes(process.env.GITHUB_EVENT_NAME));
  const commit = process.env.GITHUB_SHA;
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), commit);
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  const result = planRelease(pkg, await readRegistry(), commit, isGitAncestor);
  if (result.publish) stampRelease('.', result.version, commit, process.env.GITHUB_RUN_ID);
  console.log(`${result.reason} Version: ${result.version}`);
  appendFileSync(process.env.GITHUB_OUTPUT, `publish=${result.publish}\nversion=${result.version}\n`);
  appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `Release plan: ${result.reason} Version: **${result.version}**. Source: \`${commit}\`.\n\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
