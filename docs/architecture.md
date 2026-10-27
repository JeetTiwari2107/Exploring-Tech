# Architecture

LocalGit Studio is a single-machine developer tool. Its public GitHub Pages site is static HTML and CSS; the site does not run the editor or receive local repository data.

## Runtime

- The React interface in `frontend/` is built with Vite.
- The Node.js API in `backend/` binds to `127.0.0.1` and serves the production UI after a build.
- Startup requires one explicit `--repo <path>` or `--root <path>` selection. A repository selection limits access to that repository; a root selection allows repositories beneath that folder.
- The installed Git executable remains authoritative for repository state and remote operations.
- S3-compatible storage is optional. It is used only for manual, user-selected personal backups; Git remotes remain the collaboration mechanism.

## Boundaries

- The API rejects non-local Host/Origin requests, limits API traffic to 300 requests per minute per local client, uses a per-process CSRF token for mutations, bounds input and Git output, and provides a fixed Git operation set without shell execution.
- Workspace paths are resolved within the selected root; traversal and symlink escapes are rejected.
- AWS credentials stay in the local process through the AWS SDK provider chain. They are not sent to the browser or written into backup manifests.
- Restore previews hash selected files and require an explicit confirmation before replacing a changed local file.

## Development and verification

Run `npm run setup` once, then start a workspace with `npm run dev -- --repo <path>` or `npm run dev -- --root <path>`. Use `npm test` for backend tests and `npm run build` for the production frontend. GitHub Actions also run dependency audits, secret scanning, and CodeQL.
