import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { createTempDirectory } from './helpers/git-fixture.js';

async function createServer(t, workspace, options = {}) {
  const server = createApp({ workspace, ...options }).listen(0, '127.0.0.1');
  try {
    await new Promise((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
  } catch (error) {
    server.close();
    if (['EACCES', 'EPERM'].includes(error.code)) return t.skip('The sandbox blocks loopback HTTP sockets.');
    throw error;
  }
  t.after(() => new Promise((resolve) => server.close(() => resolve())));
  return `http://127.0.0.1:${server.address().port}`;
}

async function request(base, route, { method = 'GET', csrf, origin, body, host } = {}) {
  const headers = {};
  if (csrf) headers['x-localgit-csrf'] = csrf;
  if (origin) headers.origin = origin;
  if (host) headers.host = host;
  const url = new URL(route, base);
  const payload = body === undefined ? undefined : JSON.stringify(body);
  if (payload !== undefined) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = Buffer.byteLength(payload);
  }
  return new Promise((resolve, reject) => {
    const client = httpRequest({ hostname: url.hostname, port: url.port, path: `${url.pathname}${url.search}`, method, headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.once('end', () => {
        const data = Buffer.concat(chunks).toString('utf8');
        const headers = Object.fromEntries(Object.entries(response.headers).map(([name, value]) => [name.toLowerCase(), value]));
        try { resolve({ response: { status: response.statusCode, headers }, data: JSON.parse(data) }); }
        catch (error) { reject(error); }
      });
    });
    client.once('error', (error) => {
      if (['EACCES', 'EPERM'].includes(error.code)) {
        reject(Object.assign(new Error('The sandbox blocks loopback HTTP connections.'), { code: 'LOCAL_HTTP_BLOCKED' }));
      } else reject(error);
    });
    if (payload !== undefined) client.write(payload);
    client.end();
  });
}

async function runWithLocalHttpSkip(t, operation) {
  try { await operation(); }
  catch (error) {
    if (error.code === 'LOCAL_HTTP_BLOCKED') return t.skip('The sandbox blocks loopback HTTP connections.');
    throw error;
  }
}

test('local HTTP workspace flow protects the API and observes editor-style filesystem changes', async (t) => runWithLocalHttpSkip(t, async () => {
  const root = await createTempDirectory(t, '.tmp-localgit-api-');
  const repo = path.join(root, 'demo');
  await mkdir(repo);
  execFileSync('git', ['init', '--quiet', '--initial-branch=main', repo]);
  execFileSync('git', ['-C', repo, 'config', 'user.name', 'LocalGit API Test']);
  execFileSync('git', ['-C', repo, 'config', 'user.email', 'api-test@example.invalid']);
  await writeFile(path.join(repo, 'README.md'), 'initial\n');
  execFileSync('git', ['-C', repo, 'add', '--', 'README.md']);
  execFileSync('git', ['-C', repo, 'commit', '--quiet', '-m', 'initial']);
  await writeFile(path.join(repo, 'README.md'), 'staged through the local API\n');
  execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://username:secret@example.invalid/owner/repo.git']);

  const base = await createServer(t, { root, mode: 'root' });
  if (typeof base !== 'string') return;
  const session = await request(base, '/api/session');
  assert.equal(session.response.status, 200);
  const health = await request(base, '/health');
  assert.equal(health.data.ok, true);
  assert.equal(health.response.headers['x-content-type-options'], 'nosniff');
  assert.match(health.response.headers['content-security-policy'], /default-src 'self'/);
  assert.equal(health.response.headers['x-powered-by'], undefined);
  assert.match(session.data.csrfToken, /^[A-Za-z0-9_-]{40,}$/);
  assert.deepEqual((await request(base, '/api/workspace')).data.repositories.map(({ id }) => id), ['demo']);
  assert.equal((await request(base, '/api/workspace/status?repo=demo')).data.branch, 'main');
  assert.match((await request(base, '/api/workspace/diff?repo=demo&path=README.md')).data.diff, /staged through the local API/);

  const forbiddenOrigin = await request(base, '/api/session', { origin: 'http://attacker.example' });
  assert.equal(forbiddenOrigin.response.status, 403);
  const forbiddenHost = await request(base, '/api/session', { host: 'attacker.example' });
  assert.equal(forbiddenHost.response.status, 403);
  const noCsrf = await request(base, '/api/workspace/stage', { method: 'POST', body: { repo: 'demo', paths: ['README.md'] } });
  assert.equal(noCsrf.response.status, 403);
  const oversized = await request(base, '/api/workspace/stage', { method: 'POST', csrf: session.data.csrfToken, body: { payload: 'x'.repeat(66 * 1024) } });
  assert.equal(oversized.response.status, 413);
  assert.equal(oversized.data.error, 'REQUEST_TOO_LARGE');

  const localOrigin = base;
  const stage = await request(base, '/api/workspace/stage', { method: 'POST', csrf: session.data.csrfToken, origin: localOrigin, body: { repo: 'demo', paths: ['README.md'] } });
  assert.equal(stage.response.status, 200);
  const commit = await request(base, '/api/workspace/commit', { method: 'POST', csrf: session.data.csrfToken, origin: localOrigin, body: { repo: 'demo', message: 'reviewed through local API' } });
  assert.equal(commit.response.status, 200);
  const history = await request(base, '/api/workspace/history?repo=demo');
  assert.equal(history.data.commits[0].subject, 'reviewed through local API');
  const remotes = await request(base, '/api/workspace/remotes?repo=demo');
  assert.deepEqual(remotes.data.remotes[0].urls, ['https://example.invalid/owner/repo.git']);

  await writeFile(path.join(repo, 'README.md'), 'edited in an external editor\n');
  const changed = await request(base, '/api/workspace/status?repo=demo');
  assert.ok(changed.data.files.some((file) => file.path === 'README.md' && file.unstaged));
  const traversal = await request(base, '/api/workspace/status?repo=..%2F..');
  assert.equal(traversal.response.status, 400);
  assert.equal(await readFile(path.join(repo, 'README.md'), 'utf8'), 'edited in an external editor\n');
}));

test('the HTTP initialize action creates a Git repository without deleting existing files', async (t) => runWithLocalHttpSkip(t, async () => {
  const root = await createTempDirectory(t, '.tmp-localgit-init-api-');
  await writeFile(path.join(root, 'keep.txt'), 'preserve');
  const base = await createServer(t, { root, mode: 'root' });
  if (typeof base !== 'string') return;
  const session = await request(base, '/api/session');
  const initialized = await request(base, '/api/workspace/init', { method: 'POST', csrf: session.data.csrfToken, origin: base, body: {} });
  assert.equal(initialized.response.status, 201);
  assert.equal((await readFile(path.join(root, 'keep.txt'), 'utf8')), 'preserve');
  assert.equal((await request(base, '/api/workspace/status')).data.branch, 'main');
}));
test('API rate limiter rejects excess requests from a local client', async (t) => runWithLocalHttpSkip(t, async () => {
  const root = await createTempDirectory(t, '.tmp-localgit-rate-limit-');
  const base = await createServer(t, { root, mode: 'root' }, { apiRateLimit: 1 });
  if (typeof base !== 'string') return;
  const accepted = await request(base, '/api/session');
  assert.equal(accepted.response.status, 200);
  const limited = await request(base, '/api/session');
  assert.equal(limited.response.status, 429);
  assert.equal(limited.data.error, 'LOCAL_REQUEST_RATE_LIMIT');
  assert.ok(limited.response.headers['retry-after']);
}));
