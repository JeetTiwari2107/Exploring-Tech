import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.length !== 2 || !['--root', '--repo'].includes(args[0]) || !args[1]) {
  console.error('Usage: npm run dev -- --root <directory> | --repo <git-repository>');
  process.exit(1);
}

const node = process.execPath;
const backend = spawn(node, ['--watch', 'backend/src/server.js', ...args], {
  cwd: root,
  env: { ...process.env, LOCAL_GIT_PORT: '5000' },
  stdio: 'inherit',
});
const viteCli = path.join(root, 'frontend', 'node_modules', 'vite', 'bin', 'vite.js');
const frontend = spawn(node, [viteCli], { cwd: path.join(root, 'frontend'), stdio: 'inherit' });

let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  backend.kill();
  frontend.kill();
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
backend.once('exit', (code) => {
  if (!stopping) process.exitCode = code ?? 1;
  stop();
});
frontend.once('exit', (code) => {
  if (!stopping) process.exitCode = code ?? 1;
  stop();
});
