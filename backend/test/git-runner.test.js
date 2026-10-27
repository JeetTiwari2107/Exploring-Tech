import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runGit } from '../src/git/git-runner.js';

test('Git runner passes argv literally and never starts a shell', async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'localgit-runner-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const marker = path.join(cwd, 'executed.txt');
  const result = await runGit(cwd, ['--version; touch', marker]);
  assert.notEqual(result.exitCode, 0);
  await assert.rejects(import('node:fs/promises').then(({ access }) => access(marker)));
});

test('Git runner bounds output and applies an execution timeout', async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'localgit-runner-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const bounded = await runGit(cwd, ['--version'], { outputLimit: 4 });
  assert.equal(bounded.truncated, true);
  assert.ok(Buffer.byteLength(bounded.stdout) <= 4);
  const timed = await runGit(cwd, ['status'], { timeoutMs: 1 });
  assert.equal(timed.timedOut, true);
});
