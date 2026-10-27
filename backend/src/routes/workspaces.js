import { Router } from 'express';
import { getBranches, getDiff, getHistory, getRemotes, getStatus } from '../git/repository.js';
import { commitChanges, createBranch, fetchRemote, pullFastForward, pushRemote, stagePaths, switchBranch, unstagePaths } from '../git/mutations.js';
import { listRepositories, initializeRepository } from '../workspace/repositories.js';
import { resolveRepoPath } from '../workspace/paths.js';

export function createWorkspaceRouter(workspace) {
  const router = Router();
  async function repositoryPath(req) {
    const candidate = req.body?.repo ?? req.query.repo ?? '.';
    if (typeof candidate !== 'string') throw Object.assign(new Error('Repository selection is invalid.'), { status: 400 });
    return resolveRepoPath(workspace.root, candidate);
  }

  router.get('/', async (_req, res) => {
    res.json({ repositories: await listRepositories(workspace) });
  });
  router.get('/status', async (req, res) => res.json(await getStatus(await repositoryPath(req))));
  router.get('/diff', async (req, res) => {
    const staged = req.query.staged === 'true' || req.query.staged === '1';
    const path = req.query.path;
    if (path !== undefined && typeof path !== 'string') throw Object.assign(new Error('File path is invalid.'), { status: 400 });
    res.json({ diff: await getDiff(await repositoryPath(req), { path, staged }) });
  });
  router.get('/history', async (req, res) => res.json({ commits: await getHistory(await repositoryPath(req)) }));
  router.get('/branches', async (req, res) => res.json({ branches: await getBranches(await repositoryPath(req)) }));
  router.get('/remotes', async (req, res) => res.json({ remotes: await getRemotes(await repositoryPath(req)) }));

  router.post('/init', async (_req, res) => {
    if (workspace.mode !== 'root') throw Object.assign(new Error('Initialize a repository from an explicitly selected root folder.'), { status: 400 });
    await initializeRepository(workspace.root);
    res.status(201).json({ initialized: true });
  });
  router.post('/stage', async (req, res) => {
    await stagePaths(await repositoryPath(req), req.body?.paths);
    res.json({ staged: true });
  });
  router.post('/unstage', async (req, res) => {
    await unstagePaths(await repositoryPath(req), req.body?.paths);
    res.json({ unstaged: true });
  });
  router.post('/commit', async (req, res) => {
    await commitChanges(await repositoryPath(req), req.body?.message);
    res.json({ committed: true });
  });
  router.post('/branch/create', async (req, res) => {
    await createBranch(await repositoryPath(req), req.body?.name);
    res.status(201).json({ created: true });
  });
  router.post('/branch/switch', async (req, res) => {
    await switchBranch(await repositoryPath(req), req.body?.name);
    res.json({ switched: true });
  });
  router.post('/remote/fetch', async (req, res) => {
    await fetchRemote(await repositoryPath(req), req.body?.name);
    res.json({ fetched: true });
  });
  router.post('/remote/pull', async (req, res) => {
    await pullFastForward(await repositoryPath(req));
    res.json({ pulled: true });
  });
  router.post('/remote/push', async (req, res) => {
    await pushRemote(await repositoryPath(req), req.body?.name);
    res.json({ pushed: true });
  });

  return router;
}
