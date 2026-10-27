import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createGitFixture, createTempDirectory } from './helpers/git-fixture.js';
import { getBranches, getDiff, getHistory, getRemotes, getStatus } from '../src/git/repository.js';
import { initializeRepository } from '../src/workspace/repositories.js';

test('new repository initialization preserves files and refuses an existing repository', async (t) => {
  const root = await createTempDirectory(t, '.tmp-localgit-init-');
  await writeFile(path.join(root, 'existing.txt'), 'keep me');
  await initializeRepository(root);
  assert.equal((await lstat(path.join(root, '.git'))).isDirectory(), true);
  assert.equal(await readFile(path.join(root, 'existing.txt'), 'utf8'), 'keep me');
  await assert.rejects(initializeRepository(root), /already a Git repository/i);
});

test('Git status reports untracked, staged, unstaged, and renamed paths safely', async (t) => {
  const { root, git } = await createGitFixture(t);
  const trickyName = 'change ;$(no-shell).txt';
  await writeFile(path.join(root, 'tracked.txt'), 'before\n');
  git(['add', '--', 'tracked.txt']);
  git(['commit', '-m', 'initial']);
  await writeFile(path.join(root, 'tracked.txt'), 'after\n');
  await writeFile(path.join(root, trickyName), 'untracked\n');
  const status = await getStatus(root);
  assert.equal(status.branch, 'main');
  assert.ok(status.files.some((file) => file.path === 'tracked.txt' && file.unstaged));
  assert.ok(status.files.some((file) => file.path === trickyName && file.untracked));
  assert.ok(status.files.every((file) => !file.absolutePath));
});

test('Git diffs and history use repository-relative paths and return recent commits', async (t) => {
  const { root, git } = await createGitFixture(t);
  const filename = 'change ;$(no-shell).txt';
  await writeFile(path.join(root, filename), 'before\n');
  git(['add', '--', filename]);
  git(['commit', '-m', 'initial change']);
  await writeFile(path.join(root, filename), 'after\n');
  const diff = await getDiff(root, { path: filename, staged: false });
  assert.match(diff, /after/);
  await assert.rejects(getDiff(root, { path: '../escape', staged: false }), /path/i);
  const history = await getHistory(root);
  assert.equal(history[0].subject, 'initial change');
  assert.equal((await getBranches(root))[0].name, 'main');
});

test('configured remote credentials are redacted from local API results', async (t) => {
  const { root, git } = await createGitFixture(t);
  git(['remote', 'add', 'origin', 'https://username:secret@example.invalid/owner/repo.git']);
  assert.deepEqual(await getRemotes(root), [{ name: 'origin', urls: ['https://example.invalid/owner/repo.git'] }]);
});
