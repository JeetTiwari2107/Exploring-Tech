import { lstat, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { runGit } from '../git/git-runner.js';

const ignoredDirectories = new Set(['.git', 'node_modules', '.local', '.cache', '.codex', 'dist', 'build', 'coverage', 'vendor']);
const maximumRepositories = 200;
const maximumDirectories = 2000;

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function hasGitMarker(directory) {
  try {
    const marker = await lstat(path.join(directory, '.git'));
    return marker.isDirectory() || marker.isFile();
  } catch {
    return false;
  }
}

export async function listRepositories(workspace) {
  if (workspace.mode === 'repo' || await hasGitMarker(workspace.root)) {
    return [{ id: '.', name: path.basename(workspace.root), path: '.' }];
  }
  const repositories = [];
  const root = await realpath(workspace.root);
  const queue = [{ directory: root, relative: '.', depth: 0 }];
  let visited = 0;
  while (queue.length && repositories.length < maximumRepositories && visited < maximumDirectories) {
    const current = queue.shift();
    if (current.relative !== '.' && await hasGitMarker(current.directory)) {
      repositories.push({ id: current.relative, name: path.basename(current.directory), path: current.relative });
      continue;
    }
    if (current.depth >= 3) continue;
    let entries;
    try {
      entries = await readdir(current.directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (repositories.length >= maximumRepositories || visited >= maximumDirectories) break;
      if (!entry.isDirectory() || entry.isSymbolicLink() || ignoredDirectories.has(entry.name.toLowerCase())) continue;
      visited += 1;
      const directory = path.join(current.directory, entry.name);
      try {
        const info = await lstat(directory);
        if (!info.isDirectory() || info.isSymbolicLink()) continue;
        const canonical = await realpath(directory);
        if (!isWithin(root, canonical)) continue;
      } catch {
        continue;
      }
      const relative = current.relative === '.' ? entry.name : path.posix.join(current.relative, entry.name);
      queue.push({ directory, relative, depth: current.depth + 1 });
    }
  }
  return repositories;
}

export async function initializeRepository(root) {
  if (await hasGitMarker(root)) throw Object.assign(new Error('The selected directory is already a Git repository.'), { status: 409 });
  const result = await runGit(root, ['init', '--initial-branch=main']);
  if (result.exitCode !== 0 || result.timedOut) throw Object.assign(new Error('Git could not initialize this directory.'), { status: 400 });
}
