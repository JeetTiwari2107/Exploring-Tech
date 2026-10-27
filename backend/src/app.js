import { randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import { createWorkspaceRouter } from './routes/workspaces.js';
import { createBackupRouter } from './routes/backups.js';
import { createBackupService } from './storage/backup-service.js';
import { createS3Client, getS3Config } from './storage/s3-client.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const frontendBuild = path.resolve(here, '../../frontend/dist');
const loopbackNames = new Set(['localhost', '127.0.0.1', '[::1]']);
const mutationMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function parseLocalUrl(value) {
  if (typeof value !== 'string' || value.length > 512) return null;
  try {
    const parsed = new URL(value.includes('://') ? value : `http://${value}`);
    if (parsed.username || parsed.password || !loopbackNames.has(parsed.hostname.toLowerCase())) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function isLocalRequestAllowed(hostValue, originValue, fetchSite) {
  const host = parseLocalUrl(hostValue);
  if (!host || host.pathname !== '/' || host.search || host.hash) return false;
  if (originValue) {
    const origin = parseLocalUrl(originValue);
    const originIsLoopback = origin && origin.protocol === 'http:' && origin.origin === originValue;
    const samePort = originIsLoopback && origin.port === host.port;
    const devPort = originIsLoopback && origin.port === '3000';
    if (!originIsLoopback || (!samePort && !devPort)) return false;
  }
  return fetchSite !== 'cross-site';
}

function localRequestGuard(req, res, next) {
  if (!isLocalRequestAllowed(req.get('host'), req.get('origin'), req.get('sec-fetch-site'))) {
    return res.status(403).json({ error: 'LOCAL_REQUEST_REQUIRED' });
  }
  next();
}

function securityHeaders(_req, res, next) {
  res.set({
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  });
  next();
}

export function createCsrfToken() {
  return randomBytes(32).toString('base64url');
}

export function hasValidCsrfToken(candidate, expected) {
  if (typeof candidate !== 'string' || candidate.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(candidate), Buffer.from(expected));
}

export function createConcurrencyGuard(limit = 24) {
  if (!Number.isInteger(limit) || limit < 1) throw new TypeError('Request concurrency limit must be a positive integer.');
  let active = 0;
  return (_req, res, next) => {
    if (active >= limit) {
      res.set('Retry-After', '1');
      return res.status(429).json({ error: 'LOCAL_REQUEST_LIMIT' });
    }
    active += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      active = Math.max(0, active - 1);
    };
    res.once('finish', release);
    res.once('close', release);
    next();
  };
}

export function createApp({ workspace, csrfToken = createCsrfToken(), apiRateLimit = 300 } = {}) {
  if (!workspace?.root || !['root', 'repo'].includes(workspace.mode)) throw new Error('A validated workspace selection is required.');
  let backupConfig;
  let backupConfigurationError = false;
  try { backupConfig = getS3Config(); } catch { backupConfig = { bucket: '', prefix: '', region: 'us-east-1' }; backupConfigurationError = true; }
  const backupService = createBackupService({ config: backupConfig, client: createS3Client(backupConfig), configError: backupConfigurationError });
  const app = express();
  app.disable('x-powered-by');
  app.use(securityHeaders);
  app.use(localRequestGuard);
  app.use('/api', rateLimit({
    windowMs: 60 * 1000,
    limit: apiRateLimit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'LOCAL_REQUEST_RATE_LIMIT' },
  }));
  app.use(createConcurrencyGuard());
  app.use((req, res, next) => {
    if (req.path.startsWith('/api/') && mutationMethods.has(req.method) && !hasValidCsrfToken(req.get('x-localgit-csrf'), csrfToken)) {
      return res.status(403).json({ error: 'CSRF_TOKEN_REQUIRED' });
    }
    next();
  });
  app.use(express.json({ limit: '64kb', strict: true }));

  app.get('/health', (_req, res) => res.set('Cache-Control', 'no-store').json({ ok: true, service: 'localgit-studio' }));
  app.get('/api/session', (_req, res) => {
    res.set('Cache-Control', 'no-store').json({
      csrfToken,
      workspace: { mode: workspace.mode, name: path.basename(workspace.root) || 'root folder' },
    });
  });

  app.use('/api', (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  app.use('/api/workspace', createWorkspaceRouter(workspace));
  app.use('/api/backups', createBackupRouter(workspace, backupService));
  app.use('/api', (_req, res) => res.status(404).json({ error: 'NOT_FOUND' }));
  app.use(express.static(frontendBuild, { dotfiles: 'deny', index: false, maxAge: '1h', fallthrough: true }));
  app.get(/.*/, (req, res, next) => {
    if (!req.accepts('html') || req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(frontendBuild, 'index.html'), (error) => error && next(error));
  });

  app.use((error, _req, res, next) => {
    if (res.headersSent) return next(error);
    const status = Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 400;
    const message = status >= 500 ? 'The local operation failed.' : error.message || 'The request is invalid.';
    res.status(status).json({ error: status === 413 ? 'REQUEST_TOO_LARGE' : 'LOCAL_OPERATION_FAILED', message, ...(error.details ? { details: error.details } : {}) });
  });
  return app;
}
