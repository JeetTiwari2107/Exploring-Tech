import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
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

test('Git runner bounds output', async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'localgit-runner-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const bounded = await runGit(cwd, ['--version'], { outputLimit: 4 });
  assert.equal(bounded.truncated, true);
  assert.ok(Buffer.byteLength(bounded.stdout) <= 4);
});

test('Git runner terminates a child that exceeds its execution timeout', { skip: process.platform === 'win32' }, async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'localgit-runner-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const bin = path.join(cwd, 'bin');
  await import('node:fs/promises').then(({ mkdir }) => mkdir(bin));
  const fakeGit = path.join(bin, 'git');
  await writeFile(fakeGit, '#!/usr/bin/env node\nsetTimeout(() => {}, 2000);\n');
  await chmod(fakeGit, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ''}`;
  try {
    const timed = await runGit(cwd, ['status'], { timeoutMs: 50 });
    assert.equal(timed.timedOut, true);
    assert.equal(timed.exitCode, null);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
});
