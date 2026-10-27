import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseWorkspaceArgs, resolveWorkspaceSelection } from '../src/workspace/selection.js';

test('workspace arguments require exactly one explicit mode and path', () => {
  assert.throws(() => parseWorkspaceArgs([]), /--root|--repo/);
  assert.throws(() => parseWorkspaceArgs(['--root']), /path/i);
  assert.throws(() => parseWorkspaceArgs(['--root', 'a', '--repo', 'b']), /exactly one/i);
  assert.deepEqual(parseWorkspaceArgs(['--repo', 'C:\\projects\\demo']), { mode: 'repo', path: 'C:\\projects\\demo' });
});

test('root mode canonicalizes an existing directory', async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'localgit-selection-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'workspace');
  await mkdir(root);
  const result = await resolveWorkspaceSelection({ mode: 'root', path: root });
  assert.equal(result.mode, 'root');
  assert.equal(result.root, await (await import('node:fs/promises')).realpath(root));
});

test('repo mode requires a Git repository', async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'localgit-selection-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  await assert.rejects(resolveWorkspaceSelection({ mode: 'repo', path: parent }), /Git repository/i);
  const gitDir = path.join(parent, '.git');
  await mkdir(gitDir);
  const result = await resolveWorkspaceSelection({ mode: 'repo', path: parent });
  assert.equal(result.root, await (await import('node:fs/promises')).realpath(parent));
  await rm(gitDir, { recursive: true, force: true });
  await writeFile(path.join(parent, '.git'), 'gitdir: .git/worktrees/example\n');
  assert.equal((await resolveWorkspaceSelection({ mode: 'repo', path: parent })).mode, 'repo');
});

test('invalid and non-directory selections are rejected', async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'localgit-selection-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  await assert.rejects(resolveWorkspaceSelection({ mode: 'root', path: path.join(parent, 'missing') }), /directory|exist/i);
  await assert.rejects(resolveWorkspaceSelection({ mode: 'other', path: parent }), /mode/i);
});
