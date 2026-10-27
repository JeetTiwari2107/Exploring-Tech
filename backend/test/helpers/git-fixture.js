import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const fixtureDirectory = path.dirname(fileURLToPath(import.meta.url));

export async function createTempDirectory(t, prefix = '.tmp-localgit-fixture-') {
  const root = await mkdtemp(path.join(fixtureDirectory, prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

export async function createGitFixture(t) {
  const root = await createTempDirectory(t);
  const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git(['init', '--quiet', '-b', 'main']);
  git(['config', 'user.name', 'LocalGit Test']);
  git(['config', 'user.email', 'test@example.invalid']);
  return { root, git };
}
