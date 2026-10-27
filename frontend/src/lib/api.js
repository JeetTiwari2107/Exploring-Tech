const jsonHeaders = { 'Content-Type': 'application/json' };
let csrfToken = null;

export async function bootstrapSession() {
  const response = await fetch('/api/session', { cache: 'no-store' });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload?.message || 'Could not connect to the local workspace.');
  csrfToken = payload.csrfToken;
  return payload;
}

export async function api(path, options = {}) {
  const method = (options.method || 'GET').toUpperCase();
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) && !csrfToken) await bootstrapSession();
  const headers = { ...(options.body ? jsonHeaders : {}), ...(options.headers || {}) };
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) headers['x-localgit-csrf'] = csrfToken;
  const response = await fetch(path, { cache: 'no-store', ...options, headers });
  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) {
    const error = new Error(payload?.message || payload || `Request failed (${response.status})`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

export const get = (path) => api(path);
export const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body) });
export const del = (path) => api(path, { method: 'DELETE' });
