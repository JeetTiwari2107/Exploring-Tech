import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveRepoPath } from '../src/workspace/paths.js';

test('repo resolution rejects traversal and absolute paths', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'localgit-paths-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  await mkdir(path.join(repo, '.git'), { recursive: true });
  await assert.rejects(resolveRepoPath(root, '../outside'), /outside|traversal/i);
  await assert.rejects(resolveRepoPath(root, 'C:outside'), /relative/i);
  await assert.rejects(resolveRepoPath(root, repo), /relative/i);
});

test('repo resolution allows only a Git repo below the selected root', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'localgit-paths-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'nested', 'repo', '.git'), { recursive: true });
  const result = await resolveRepoPath(root, 'nested/repo');
  assert.equal(result, await (await import('node:fs/promises')).realpath(path.join(root, 'nested', 'repo')));
  await assert.rejects(resolveRepoPath(root, 'nested'), /Git repository/i);
});

test('repo resolution rejects a symlink that escapes the selected root', async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'localgit-paths-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'root');
  const outside = path.join(parent, 'outside');
  await mkdir(root);
  await mkdir(path.join(outside, '.git'), { recursive: true });
  try {
    await symlink(outside, path.join(root, 'escape'), 'junction');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip(`Symlink creation unavailable: ${error.code}`);
    throw error;
  }
  await assert.rejects(resolveRepoPath(root, 'escape'), /outside|escape/i);
});
