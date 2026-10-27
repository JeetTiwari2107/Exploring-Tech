import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createConcurrencyGuard, createCsrfToken, hasValidCsrfToken, isLocalRequestAllowed } from '../src/app.js';

test('local request guard accepts loopback hosts and the same-origin/dev UI only', () => {
  assert.equal(isLocalRequestAllowed('127.0.0.1:5000', 'http://localhost:3000'), true);
  assert.equal(isLocalRequestAllowed('localhost:3000', 'http://localhost:3000'), true);
  assert.equal(isLocalRequestAllowed('127.0.0.1:5000', undefined), true);
  assert.equal(isLocalRequestAllowed('attacker.example', 'http://attacker.example'), false);
  assert.equal(isLocalRequestAllowed('localhost:5000', 'https://localhost:5000'), false);
  assert.equal(isLocalRequestAllowed('localhost:5000', 'http://localhost:5001'), false);
  assert.equal(isLocalRequestAllowed('localhost:5000', 'http://localhost:5000/path'), false);
  assert.equal(isLocalRequestAllowed('localhost:5000', 'http://localhost:3000', 'cross-site'), false);
});

test('CSRF tokens are random per process and compared without accepting malformed input', () => {
  const first = createCsrfToken();
  const second = createCsrfToken();
  assert.match(first, /^[A-Za-z0-9_-]{40,}$/);
  assert.notEqual(first, second);
  assert.equal(hasValidCsrfToken(first, first), true);
  assert.equal(hasValidCsrfToken(`${first}x`, first), false);
  assert.equal(hasValidCsrfToken(undefined, first), false);
  assert.equal(hasValidCsrfToken('', first), false);
});

test('local request concurrency guard rejects excess work and releases once on close/finish', () => {
  const guard = createConcurrencyGuard(1);
  const createResponse = () => {
    const response = new EventEmitter();
    response.set = () => response;
    response.status = (status) => { response.statusCode = status; return response; };
    response.json = (body) => { response.body = body; return response; };
    return response;
  };
  let accepted = 0;
  const first = createResponse();
  guard({}, first, () => { accepted += 1; });
  const excess = createResponse();
  guard({}, excess, () => { accepted += 1; });
  assert.equal(accepted, 1);
  assert.equal(excess.statusCode, 429);
  assert.equal(excess.body.error, 'LOCAL_REQUEST_LIMIT');
  first.emit('close');
  first.emit('finish');
  const afterClose = createResponse();
  guard({}, afterClose, () => { accepted += 1; });
  assert.equal(accepted, 2);
});
