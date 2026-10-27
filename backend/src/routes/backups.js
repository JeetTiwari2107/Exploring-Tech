import { Router } from 'express';
import { resolveRepoPath } from '../workspace/paths.js';

export function createBackupRouter(workspace, backupService) {
  const router = Router();
  async function repositoryPath(req) {
    const candidate = req.body?.repo ?? req.query.repo ?? '.';
    if (typeof candidate !== 'string') throw Object.assign(new Error('Repository selection is invalid.'), { status: 400 });
    return resolveRepoPath(workspace.root, candidate);
  }

  router.get('/config', (_req, res) => res.json(backupService.configuration()));
  router.get('/manifest', async (req, res) => res.json(await backupService.getManifest(await repositoryPath(req))));
  router.post('/preview', async (req, res) => res.json(await backupService.createBackupPreview(await repositoryPath(req), req.body?.paths)));
  router.post('/backup', async (req, res) => res.json(await backupService.backup(req.body?.previewId, await repositoryPath(req))));
  router.post('/restore/preview', async (req, res) => res.json(await backupService.createRestorePreview(await repositoryPath(req), req.body?.paths)));
  router.post('/restore', async (req, res) => res.json(await backupService.restore(req.body?.previewId, await repositoryPath(req), req.body?.confirmOverwritePaths)));
  return router;
}
