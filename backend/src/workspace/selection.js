import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

const usage = 'Usage: npm start -- --root <directory> | --repo <git-repository>';

export function parseWorkspaceArgs(argv) {
  if (!Array.isArray(argv) || argv.length !== 2) throw new Error(`${usage} (choose exactly one mode and path)`);
  const [flag, selectedPath] = argv;
  if (flag !== '--root' && flag !== '--repo') throw new Error(usage);
  if (typeof selectedPath !== 'string' || selectedPath.trim() === '' || selectedPath.startsWith('--')) {
    throw new Error(`${usage} (a path is required)`);
  }
  return { mode: flag === '--root' ? 'root' : 'repo', path: selectedPath };
}

async function assertDirectory(directory) {
  let details;
  try {
    details = await lstat(directory);
  } catch {
    throw new Error('Selected workspace directory does not exist.');
  }
  if (!details.isDirectory()) throw new Error('Selected workspace path must be a directory.');
}

async function isGitRepository(directory) {
  try {
    const marker = await lstat(path.join(directory, '.git'));
    return marker.isDirectory() || marker.isFile();
  } catch {
    return false;
  }
}

export async function resolveWorkspaceSelection(selection) {
  if (!selection || !['root', 'repo'].includes(selection.mode)) throw new Error('Workspace mode must be root or repo.');
  if (typeof selection.path !== 'string' || selection.path.trim() === '') throw new Error('Workspace path is required.');
  const root = await realpath(path.resolve(selection.path));
  await assertDirectory(root);
  if (selection.mode === 'repo' && !(await isGitRepository(root))) {
    throw new Error('Selected directory is not a Git repository.');
  }
  return Object.freeze({ mode: selection.mode, root });
}
