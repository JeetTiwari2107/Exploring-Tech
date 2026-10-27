import { S3Client } from '@aws-sdk/client-s3';

function normalizePrefix(value) {
  const prefix = (value || 'localgit-studio/backups').replace(/^\/+|\/+$/g, '');
  if (prefix.length > 200 || prefix.split('/').some((part) => !part || part === '.' || part === '..') || /[\u0000-\u001f\u007f]/.test(prefix)) {
    throw new Error('LOCAL_GIT_S3_PREFIX is invalid.');
  }
  return prefix;
}

export function getS3Config(env = process.env) {
  const bucket = (env.LOCAL_GIT_S3_BUCKET || '').trim();
  if (bucket && (bucket.length > 63 || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) || bucket.includes('..'))) {
    throw new Error('LOCAL_GIT_S3_BUCKET must be a valid S3 bucket name.');
  }
  const region = (env.LOCAL_GIT_S3_REGION || env.AWS_REGION || 'us-east-1').trim();
  const endpoint = (env.LOCAL_GIT_S3_ENDPOINT || '').trim() || undefined;
  if (endpoint) {
    let parsed;
    try { parsed = new URL(endpoint); } catch { throw new Error('LOCAL_GIT_S3_ENDPOINT must be a valid HTTP(S) URL.'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') {
      throw new Error('LOCAL_GIT_S3_ENDPOINT must not include credentials, a path, or query parameters.');
    }
    const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
    if (parsed.protocol === 'http:' && !loopbackHosts.has(parsed.hostname.toLowerCase())) {
      throw new Error('LOCAL_GIT_S3_ENDPOINT must use HTTPS unless it points to a loopback host.');
    }
  }
  return Object.freeze({ bucket, prefix: normalizePrefix(env.LOCAL_GIT_S3_PREFIX), region, endpoint });
}

export function createS3Client(config) {
  return new S3Client({
    region: config.region,
    endpoint: config.endpoint,
    forcePathStyle: Boolean(config.endpoint),
    maxAttempts: 2,
  });
}

export function backupConfigurationView(config) {
  return { enabled: Boolean(config.bucket), endpointConfigured: Boolean(config.endpoint), region: config.region };
}
