import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createGitFixture } from './helpers/git-fixture.js';
import { commitChanges, createBranch, fetchRemote, pullFastForward, pushRemote, stagePaths, switchBranch, unstagePaths } from '../src/git/mutations.js';

test('stage, unstage, commit, and branch operations pass hostile text as data', async (t) => {
  const { root, git } = await createGitFixture(t);
  const filename = 'file ; echo should-not-run.txt';
  const marker = path.join(root, 'should-not-run.txt');
  await writeFile(path.join(root, filename), 'sample\n');
  await stagePaths(root, [filename]);
  assert.equal((await readFile(path.join(root, filename), 'utf8')), 'sample\n');
  await unstagePaths(root, [filename]);
  assert.equal(git(['status', '--porcelain']).trim(), `?? "${filename}"`);
  await stagePaths(root, [filename]);
  await commitChanges(root, 'commit & echo injected > should-not-run.txt');
  await assert.rejects(readFile(marker));
  await assert.rejects(createBranch(root, 'feature/$(no-shell)'), /branch/i);
  await createBranch(root, 'feature/safe_name');
  await switchBranch(root, 'feature/safe_name');
  assert.equal(git(['branch', '--show-current']).trim(), 'feature/safe_name');
  await assert.rejects(stagePaths(root, ['../outside']), /path/i);
  await assert.rejects(stagePaths(root, ['.env']), /credentials|settings/i);
  await assert.rejects(stagePaths(root, ['.npmrc']), /credentials|settings/i);
});

test('local bare remotes support push, fetch, and fast-forward pull without force', async (t) => {
  const { root, git } = await createGitFixture(t);
  const remote = path.join(root, 'remote.git');
  execFileSync('git', ['init', '--quiet', '--bare', remote]);
  await writeFile(path.join(root, 'README.md'), 'first\n');
  git(['add', '--', 'README.md']);
  git(['commit', '-m', 'first']);
  git(['remote', 'add', 'origin', pathToFileURL(remote).href]);
  try {
    await pushRemote(root, 'origin');
  } catch (error) {
    if (error.code === 'WINDOWS_SANDBOX_LOCAL_TRANSPORT_BLOCKED') return t.skip('The sandbox blocks Git for Windows sh.exe used by local bare-remote transport.');
    throw error;
  }

  const clone = path.join(root, 'clone');
  execFileSync('git', ['clone', '--quiet', '--branch', 'main', remote, clone]);
  execFileSync('git', ['-C', clone, 'config', 'user.name', 'Other']);
  execFileSync('git', ['-C', clone, 'config', 'user.email', 'other@example.invalid']);
  await writeFile(path.join(clone, 'README.md'), 'first\nsecond\n');
  execFileSync('git', ['-C', clone, 'commit', '-am', 'second']);
  execFileSync('git', ['-C', clone, 'push', 'origin', 'main']);
  await fetchRemote(root, 'origin');
  await pullFastForward(root);
  assert.equal((await readFile(path.join(root, 'README.md'), 'utf8')).replace(/\r\n/g, '\n'), 'first\nsecond\n');

  await writeFile(path.join(clone, 'README.md'), 'first\nsecond\nremote third\n');
  execFileSync('git', ['-C', clone, 'commit', '-am', 'remote third']);
  execFileSync('git', ['-C', clone, 'push', 'origin', 'main']);
  await writeFile(path.join(root, 'README.md'), 'first\nsecond\nlocal third\n');
  git(['commit', '-am', 'local third']);
  await fetchRemote(root, 'origin');
  await assert.rejects(pullFastForward(root), /not a fast-forward/i);
  assert.equal((await readFile(path.join(root, 'README.md'), 'utf8')).replace(/\r\n/g, '\n'), 'first\nsecond\nlocal third\n');
});

test('remote protocol helpers are rejected before Git can launch them', async (t) => {
  const { root, git } = await createGitFixture(t);
  git(['remote', 'add', 'origin', 'ext::echo-not-allowed']);
  await assert.rejects(fetchRemote(root, 'origin'), /protocol/i);
});

test('file remotes cannot target a network authority or UNC share', async (t) => {
  const { root, git } = await createGitFixture(t);
  git(['remote', 'add', 'network-file', 'file://server/share/repo.git']);
  await assert.rejects(fetchRemote(root, 'network-file'), /protocol/i);
  git(['remote', 'add', 'unc-share', '\\\\server\\share\\repo.git']);
  await assert.rejects(fetchRemote(root, 'unc-share'), /protocol/i);
  git(['remote', 'add', 'slash-unc-share', '//server/share/repo.git']);
  await assert.rejects(fetchRemote(root, 'slash-unc-share'), /protocol/i);
});

test('commit refuses sensitive files that were staged outside the application', async (t) => {
  const { root, git } = await createGitFixture(t);
  await writeFile(path.join(root, '.env'), 'LOCAL_SECRET=do-not-commit\n');
  git(['add', '-f', '--', '.env']);
  await assert.rejects(commitChanges(root, 'accidental credentials'), /credentials|settings/i);
  assert.equal(git(['status', '--porcelain']).trimStart().startsWith('A  .env'), true);
});
