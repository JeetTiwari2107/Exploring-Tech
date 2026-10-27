import { runGit } from './git-runner.js';
import { resolveGitPath } from '../workspace/paths.js';
import { getBranches, getRemotes, getStatus } from './repository.js';

const remoteNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const branchPattern = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;

function ensureNotSensitive(filePath) {
  const parts = filePath.replaceAll('\\', '/').toLowerCase().split('/');
  const name = parts.at(-1) || '';
  if (parts.some((part) => ['.aws', '.ssh', '.local', '.docker', '.kube', '.gnupg', '.config', 'credentials'].includes(part))
    || name === '.env' || name.startsWith('.env.') || name === 'id_rsa' || name === 'id_ed25519'
    || ['id_ecdsa', 'id_dsa', 'id_ecdsa_sk', 'id_ed25519_sk', '.npmrc', '.pypirc', '.netrc', '.git-credentials', 'credentials.json', 'service-account.json', 'kubeconfig'].includes(name)
    || ['.pem', '.key', '.p12', '.pfx'].some((suffix) => name.endsWith(suffix))) {
    throw Object.assign(new Error('Files that look like credentials or local settings cannot be staged in LocalGit Studio.'), { status: 400 });
  }
}

function remoteFailure(result, label) {
  if (result.timedOut) return `Git ${label} timed out. Check the remote and retry.`;
  const stderr = result.stderr.toLowerCase();
  if (stderr.includes('terminal prompts disabled') || stderr.includes('could not read username') || stderr.includes('authentication failed')) {
    return 'Git needs credentials. Configure Git Credential Manager or an SSH key in your normal Git setup, then retry.';
  }
  if (stderr.includes('not possible to fast-forward')) return 'The update is not a fast-forward. Your worktree was left intact; inspect the changes before integrating them.';
  if (stderr.includes('conflict')) return 'Git reported a conflict. Resolve it in your editor, then retry the operation.';
  return `Git ${label} failed. Review the repository state and try again.`;
}

async function execute(repoPath, args, label, remote = false) {
  const result = await runGit(repoPath, args, { timeoutMs: remote ? 60_000 : 10_000, outputLimit: 256 * 1024 });
  if (result.exitCode !== 0 || result.truncated) {
    const sandboxTransportBlocked = /NtCreateDirectoryObject/i.test(result.stderr);
    throw Object.assign(new Error(result.truncated ? `Git ${label} output was too large.` : remoteFailure(result, label)), {
      status: result.timedOut ? 504 : 400,
      ...(sandboxTransportBlocked ? { code: 'WINDOWS_SANDBOX_LOCAL_TRANSPORT_BLOCKED' } : {}),
    });
  }
  return result.stdout;
}

async function normalizedPaths(repoPath, paths) {
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > 100 || paths.some((item) => typeof item !== 'string')) {
    throw Object.assign(new Error('Select between 1 and 100 repository-relative paths.'), { status: 400 });
  }
  paths.forEach(ensureNotSensitive);
  return Promise.all(paths.map((filePath) => resolveGitPath(repoPath, filePath)));
}

export async function stagePaths(repoPath, paths) {
  const specs = await normalizedPaths(repoPath, paths);
  await execute(repoPath, ['add', '--', ...specs], 'stage');
}

export async function unstagePaths(repoPath, paths) {
  const specs = await normalizedPaths(repoPath, paths);
  await execute(repoPath, ['reset', '--quiet', '--', ...specs], 'unstage');
}

export async function commitChanges(repoPath, message) {
  if (typeof message !== 'string' || message.trim() === '' || Buffer.byteLength(message, 'utf8') > 4000 || message.includes('\0')) {
    throw Object.assign(new Error('Commit message must contain 1 to 4000 bytes.'), { status: 400 });
  }
  const status = await getStatus(repoPath);
  for (const file of status.files.filter((item) => item.staged)) {
    ensureNotSensitive(file.path);
    if (file.previousPath) ensureNotSensitive(file.previousPath);
  }
  await execute(repoPath, ['commit', '-m', message], 'commit');
}

async function validateBranch(repoPath, branch) {
  if (typeof branch !== 'string' || !branchPattern.test(branch) || branch.includes('..') || branch.includes('//') || branch.endsWith('/') || branch.endsWith('.')) {
    throw Object.assign(new Error('Branch name is invalid.'), { status: 400 });
  }
  await execute(repoPath, ['check-ref-format', '--branch', branch], 'branch validation');
  return branch;
}

export async function createBranch(repoPath, branch) {
  const validBranch = await validateBranch(repoPath, branch);
  await execute(repoPath, ['switch', '-c', validBranch], 'branch creation');
}

export async function switchBranch(repoPath, branch) {
  const validBranch = await validateBranch(repoPath, branch);
  const branches = await getBranches(repoPath);
  if (!branches.some((entry) => entry.name === validBranch)) throw Object.assign(new Error('Branch does not exist.'), { status: 404 });
  await execute(repoPath, ['switch', '--', validBranch], 'branch switch');
}

function isAllowedRemoteUrl(value) {
  if (/^[\\/]{2}[^\\/]+[\\/][^\\/]+/.test(value)) return false;
  if (/^https:\/\//i.test(value) || /^ssh:\/\//i.test(value)) return true;
  if (/^file:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      return !url.username && !url.password && !url.search && !url.hash
        && (!url.hostname || url.hostname.toLowerCase() === 'localhost');
    } catch {
      return false;
    }
  }
  if (/^(?:[A-Za-z]:[\\/]|\/|\.\.?[\\/])/.test(value)) return true;
  if (/^[^\s:@]+@[^\s/:]+:.+/.test(value)) return true;
  return false;
}

async function validateRemote(repoPath, name, push = false) {
  if (typeof name !== 'string' || !remoteNamePattern.test(name)) throw Object.assign(new Error('Remote name is invalid.'), { status: 400 });
  if (!(await getRemotes(repoPath)).some((remote) => remote.name === name)) throw Object.assign(new Error('Remote does not exist.'), { status: 404 });
  const args = ['remote', 'get-url', ...(push ? ['--push'] : []), '--all', name];
  const output = await execute(repoPath, args, 'remote validation');
  const urls = output.split(/\r?\n/).filter(Boolean);
  if (urls.length === 0 || urls.some((url) => !isAllowedRemoteUrl(url))) {
    throw Object.assign(new Error('This remote protocol is not allowed. Use HTTPS, SSH, or an explicit local Git path.'), { status: 400 });
  }
  return { name, urls };
}

export async function fetchRemote(repoPath, name) {
  const remote = await validateRemote(repoPath, name);
  await execute(repoPath, ['-c', 'protocol.ext.allow=never', 'fetch', '--no-progress', '--no-recurse-submodules', remote.name], 'fetch', true);
}

export async function pullFastForward(repoPath) {
  const status = await getStatus(repoPath);
  if (!status.upstream) throw Object.assign(new Error('No upstream branch is configured. Push once to set an upstream before pulling.'), { status: 400 });
  const remotes = await getRemotes(repoPath);
  const remoteName = remotes.map((remote) => remote.name).sort((a, b) => b.length - a.length).find((name) => status.upstream.startsWith(`${name}/`));
  if (!remoteName) throw Object.assign(new Error('The configured upstream does not use a listed remote.'), { status: 400 });
  const { urls } = await validateRemote(repoPath, remoteName);
  const branch = status.upstream.slice(remoteName.length + 1);
  if (!branchPattern.test(branch)) throw Object.assign(new Error('The configured upstream branch is invalid.'), { status: 400 });
  if (urls.some((url) => !isAllowedRemoteUrl(url))) throw Object.assign(new Error('This remote protocol is not allowed.'), { status: 400 });
  await execute(repoPath, ['-c', 'protocol.ext.allow=never', 'pull', '--ff-only', '--no-recurse-submodules', remoteName, branch], 'pull', true);
}

export async function pushRemote(repoPath, name) {
  const remote = await validateRemote(repoPath, name, true);
  if (remote.urls.some((url) => !isAllowedRemoteUrl(url))) throw Object.assign(new Error('This push remote protocol is not allowed.'), { status: 400 });
  const status = await getStatus(repoPath);
  if (!status.branch) throw Object.assign(new Error('Push is unavailable while HEAD is detached.'), { status: 400 });
  const branches = await getBranches(repoPath);
  if (!branches.some((entry) => entry.name === status.branch)) throw Object.assign(new Error('Create a commit before pushing this branch.'), { status: 400 });
  await execute(repoPath, ['-c', 'protocol.ext.allow=never', 'push', '--no-progress', '--set-upstream', remote.name, status.branch], 'push', true);
}
