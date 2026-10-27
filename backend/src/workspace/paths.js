import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function containsTraversal(candidate) {
  return candidate.split(/[\\/]+/).some((part) => part === '..');
}

function hasDrivePrefix(candidate) {
  return /^[A-Za-z]:/.test(candidate);
}

async function isGitRepository(directory) {
  try {
    const marker = await lstat(path.join(directory, '.git'));
    return marker.isDirectory() || marker.isFile();
  } catch {
    return false;
  }
}

export async function resolveRepoPath(selectedRoot, candidate) {
  if (typeof selectedRoot !== 'string' || typeof candidate !== 'string' || candidate.length === 0 || candidate.includes('\0')) {
    throw new Error('A valid repository-relative path is required.');
  }
  if (path.isAbsolute(candidate) || path.win32.isAbsolute(candidate) || hasDrivePrefix(candidate)) throw new Error('Repository path must be relative to the selected root.');
  if (containsTraversal(candidate)) throw new Error('Repository path traversal is not allowed.');

  const root = await realpath(selectedRoot);
  const unresolved = path.resolve(root, candidate);
  const unresolvedRelative = path.relative(root, unresolved);
  if (unresolvedRelative === '..' || unresolvedRelative.startsWith(`..${path.sep}`) || path.isAbsolute(unresolvedRelative)) {
    throw new Error('Repository path is outside the selected root.');
  }

  let target;
  try {
    target = await realpath(unresolved);
  } catch {
    throw new Error('Repository path does not exist inside the selected root.');
  }
  const targetRelative = path.relative(root, target);
  if (targetRelative === '..' || targetRelative.startsWith(`..${path.sep}`) || path.isAbsolute(targetRelative)) {
    throw new Error('Repository path resolves outside the selected root.');
  }
  const info = await lstat(target);
  if (!info.isDirectory()) throw new Error('Repository path must identify a directory.');
  if (!(await isGitRepository(target))) throw new Error('Selected path is not a Git repository.');
  return target;
}

export async function resolveGitPath(selectedRoot, candidate) {
  if (typeof selectedRoot !== 'string' || typeof candidate !== 'string' || candidate.length === 0 || candidate.includes('\0')) {
    throw new Error('A valid repository-relative file path is required.');
  }
  if (path.isAbsolute(candidate) || path.win32.isAbsolute(candidate) || hasDrivePrefix(candidate)) throw new Error('File path must be relative to the repository.');
  if (containsTraversal(candidate)) throw new Error('File path traversal is not allowed.');

  const root = await realpath(selectedRoot);
  const parts = candidate.split(/[\\/]+/).filter((part) => part && part !== '.');
  if (parts.length === 0) throw new Error('A file path is required.');
  let current = root;
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    if (!isWithin(root, current)) throw new Error('File path is outside the repository.');
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() && index !== parts.length - 1) throw new Error('File path cannot pass through a symbolic link.');
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') break;
      throw error;
    }
  }
  const relative = parts.join('/');
  return `:(literal)${relative}`;
}

export async function resolveWorkspaceFile(selectedRoot, candidate, { allowMissing = false } = {}) {
  if (typeof selectedRoot !== 'string' || typeof candidate !== 'string' || candidate.length === 0 || candidate.includes('\0')) {
    throw new Error('A valid repository-relative file path is required.');
  }
  if (path.isAbsolute(candidate) || path.win32.isAbsolute(candidate) || hasDrivePrefix(candidate)) throw new Error('File path must be relative to the repository.');
  if (containsTraversal(candidate)) throw new Error('File path traversal is not allowed.');
  const root = await realpath(selectedRoot);
  const parts = candidate.split(/[\\/]+/).filter((part) => part && part !== '.');
  if (parts.length === 0 || parts.some((part) => part.toLowerCase() === '.git')) throw new Error('This repository path is not available for file backup.');
  let current = root;
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    if (!isWithin(root, current)) throw new Error('File path is outside the repository.');
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error('File path cannot pass through a symbolic link.');
      if (index < parts.length - 1 && !info.isDirectory()) throw new Error('Parent path is not a directory.');
      if (index === parts.length - 1 && !info.isFile()) throw new Error('Selected path must be a regular file.');
    } catch (error) {
      if (error.code === 'ENOENT' && allowMissing) break;
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') throw new Error('File or parent directory does not exist.');
      throw error;
    }
  }
  return { absolutePath: path.join(root, ...parts), relativePath: parts.join('/') };
}
