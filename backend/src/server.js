import path from 'node:path';
import { readFile } from 'node:fs/promises';

import { createApp } from './app.js';
import { getServerConfig } from './config.js';
import { parseWorkspaceArgs, resolveWorkspaceSelection } from './workspace/selection.js';

async function loadLocalSettings() {
  let contents;
  try { contents = await readFile(path.resolve('.localgit-studio.env'), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return; throw new Error('The local settings file could not be read.'); }
  if (Buffer.byteLength(contents, 'utf8') > 16 * 1024) throw new Error('The local settings file is too large.');
  const allowed = new Set(['LOCAL_GIT_PORT', 'LOCAL_GIT_S3_BUCKET', 'LOCAL_GIT_S3_REGION', 'LOCAL_GIT_S3_PREFIX', 'LOCAL_GIT_S3_ENDPOINT', 'AWS_PROFILE']);
  for (const line of contents.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (!match || !allowed.has(match[1])) throw new Error('The local settings file contains an unsupported setting.');
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (/[\r\n]/.test(value)) throw new Error('The local settings file contains an invalid value.');
    if (value && process.env[match[1]] === undefined) process.env[match[1]] = value;
  }
}

async function startLocalGitStudio() {
  await loadLocalSettings();
  const config = getServerConfig();
  const selection = parseWorkspaceArgs(process.argv.slice(2));
  const workspace = await resolveWorkspaceSelection(selection);
  const app = createApp({ workspace });
  const server = app.listen(config.port, config.host, () => {
    console.log(`LocalGit Studio ready at http://${config.host}:${config.port} (${workspace.mode}: ${workspace.root.split(/[\\/]/).filter(Boolean).at(-1) || 'root folder'})`);
  });
  const stop = () => server.close(() => process.exit(0));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

startLocalGitStudio().catch((error) => {
  console.error(`LocalGit Studio could not start: ${error.message}`);
  process.exitCode = 1;
});
