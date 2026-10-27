import { runGit } from './git-runner.js';
import { resolveGitPath } from '../workspace/paths.js';

function failureMessage(result, label) {
  if (result.timedOut) return `Git ${label} timed out. Check the repository or remote and try again.`;
  const detail = result.stderr.toLowerCase();
  if (detail.includes('terminal prompts disabled') || detail.includes('could not read username') || detail.includes('authentication failed')) {
    return 'Git needs credentials. Configure Git Credential Manager or an SSH key in your normal Git setup, then retry.';
  }
  if (detail.includes('not possible to fast-forward')) return 'The update is not a fast-forward. Your worktree was left intact; inspect the changes before integrating them.';
  if (detail.includes('conflict')) return 'Git reported a conflict. Resolve it in your editor, then retry the operation.';
  if (detail.includes('not a git repository')) return 'The selected directory is not a usable Git repository.';
  return `Git ${label} failed. Review the repository state and try again.`;
}

async function git(repoPath, args, options, label) {
  const result = await runGit(repoPath, args, options);
  if (result.truncated) throw Object.assign(new Error(`Git ${label} output is too large to display.`), { status: 413 });
  if (result.exitCode !== 0) throw Object.assign(new Error(failureMessage(result, label)), { status: result.timedOut ? 504 : 400 });
  return result.stdout;
}

function parseStatus(output) {
  const records = output.split('\0');
  const branchLine = records.shift()?.replace(/\r?\n$/, '') || '';
  const branchDetail = branchLine.startsWith('## ') ? branchLine.slice(3) : '';
  const branch = branchDetail === 'HEAD (no branch)'
    ? null
    : branchDetail.replace(/^No commits yet on /, '').split('...')[0].trim() || null;
  const ahead = Number(branchDetail.match(/\bahead (\d+)/)?.[1] || 0);
  const behind = Number(branchDetail.match(/\bbehind (\d+)/)?.[1] || 0);
  const upstreamMatch = branchDetail.match(/\.\.\.([^\s[]+)/);
  const files = [];

  for (let index = 0; index < records.length; index += 1) {
    const entry = records[index];
    if (!entry) continue;
    const indexStatus = entry[0] || ' ';
    const worktreeStatus = entry[1] || ' ';
    const filename = entry.slice(3);
    const renamed = indexStatus === 'R' || indexStatus === 'C' || worktreeStatus === 'R' || worktreeStatus === 'C';
    const previousPath = renamed ? records[++index] || null : null;
    files.push({
      path: filename,
      previousPath,
      index: indexStatus,
      worktree: worktreeStatus,
      staged: indexStatus !== ' ' && indexStatus !== '?',
      unstaged: worktreeStatus !== ' ' && worktreeStatus !== '?',
      untracked: indexStatus === '?' && worktreeStatus === '?',
      conflicted: ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(`${indexStatus}${worktreeStatus}`),
    });
  }
  return { branch, upstream: upstreamMatch?.[1] || null, ahead, behind, files };
}

export async function getStatus(repoPath) {
  const output = await git(repoPath, ['-c', 'core.quotepath=false', 'status', '--porcelain=v1', '-z', '--branch', '--untracked-files=all'], {}, 'status');
  return parseStatus(output);
}

export async function getDiff(repoPath, { path, staged = false } = {}) {
  const args = ['-c', 'core.quotepath=false', 'diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames'];
  if (staged) args.push('--cached');
  if (path !== undefined) args.push('--', await resolveGitPath(repoPath, path));
  const output = await git(repoPath, args, { outputLimit: 512 * 1024 }, 'diff');
  return output;
}

export async function getHistory(repoPath, limit = 30) {
  const count = Number.isInteger(limit) ? Math.max(1, Math.min(limit, 100)) : 30;
  const format = '--format=%H%x00%an%x00%aI%x00%s';
  const output = await git(repoPath, ['-c', 'core.quotepath=false', 'log', '-z', '-n', String(count), '--date=iso-strict', format, '--no-color'], {}, 'history');
  const fields = output.split('\0').filter(Boolean);
  const commits = [];
  for (let index = 0; index + 3 < fields.length; index += 4) {
    const [hash, author, date, subject] = fields.slice(index, index + 4);
    commits.push({ hash, author, date, subject });
  }
  return commits;
}

export async function getBranches(repoPath) {
  const [output, current] = await Promise.all([
    git(repoPath, ['branch', '--format=%(refname:short)', '--no-color'], {}, 'branch list'),
    git(repoPath, ['branch', '--show-current'], {}, 'current branch'),
  ]);
  return output.split(/\r?\n/).filter(Boolean).map((name) => ({ name, current: name === current.trim() }));
}

function redactRemoteUrl(value) {
  if (/^(?:https?|ssh|git):\/\//i.test(value)) {
    try {
      const url = new URL(value);
      url.username = '';
      url.password = '';
      url.search = '';
      url.hash = '';
      return url.toString().replace(/\/$/, '');
    } catch {
      return '[configured remote]';
    }
  }
  if (/^file:/i.test(value)) return 'file://[local path]';
  if (/^(?:[A-Za-z]:[\\/]|\\\\|\/|\.\.?[\\/])/.test(value)) return '[local path]';
  const scp = value.match(/^(?:[^@/]+@)?([^:]+):(.+)$/);
  if (scp) return `${scp[1]}:${scp[2]}`;
  return '[local path]';
}

export async function getRemotes(repoPath) {
  const namesOutput = await git(repoPath, ['remote'], {}, 'remote list');
  const names = namesOutput.split(/\r?\n/).filter(Boolean);
  return Promise.all(names.map(async (name) => {
    const urlsOutput = await git(repoPath, ['remote', 'get-url', '--all', name], {}, 'remote details');
    return { name, urls: urlsOutput.split(/\r?\n/).filter(Boolean).map(redactRemoteUrl) };
  }));
}
