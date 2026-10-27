# LocalGit Studio

**A local-first Git workspace for developers.** Review and manage real Git repositories on your computer while continuing to edit the same files in VS Code or another editor. Git stays authoritative; optional S3-compatible storage is for manual personal backups of files you select.

This public repository contains the application source and a small static project page. The app runs on your computer; the website does not access your files or host a shared workspace.

## Features

- Open an existing Git repository or select a folder containing repositories.
- Review branches, staged and unstaged changes, diffs, recent commits, and remotes.
- Stage, unstage, commit, create and switch branches, fetch, fast-forward pull, and push.
- Edit the same working tree in VS Code or another editor.
- Back up selected large files manually to your own S3-compatible bucket, with SHA-256 verification.
- Run locally with Node.js and Git; MongoDB and Docker are not required.

## Run locally

**Requirements:** Node.js 22.12 or newer and Git 2.40 or newer.

```powershell
git clone https://github.com/JeetTiwari2107/Exploring-Tech.git
Set-Location Exploring-Tech
npm run setup
npm start -- --repo "C:\work\your-project"
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000). The server binds to loopback only. To browse repositories within a workspace folder instead, pass `--root`:

```powershell
npm start -- --root "D:\workspaces"
```

To work on the app itself, use `npm run dev -- --repo "C:\work\your-project"` or `npm run dev -- --root "D:\workspaces"`. This starts the Vite UI and local API. `npm run build` creates the production frontend.

Open the same repository folder in VS Code with **File → Open Folder** (or `code "C:\work\your-project"`). Both tools operate on the same working tree and `.git` directory.

## Git and optional S3

Git on disk is the source of truth. Git remotes handle collaboration. LocalGit Studio uses the installed Git executable for a fixed set of operations, invokes it without a shell, and does not ask for Git tokens. Pull is fast-forward only and push never force-pushes.

S3 is optional personal backup storage, not a Git remote or shared Git LFS service. To configure it, copy `.localgit-studio.env.example` to `.localgit-studio.env`, set the bucket and region, and use your normal AWS profile or credential provider. Never put access keys in the settings file. Backups are manual and limited to files you select. The browser never receives AWS credentials.

## Security

The app requires an explicit `--repo` or `--root`, binds to `127.0.0.1`, validates local Host/Origin requests, and protects API mutations with a per-process CSRF token. Workspace path checks reject traversal and symlink escapes. Sensitive files cannot be staged or backed up through the app; Git subprocesses have bounded output and timeouts. Do not expose the local server through a tunnel or reverse proxy.

GitHub Actions run tests, a production build, dependency audits, a Git-history secret scan, and CodeQL analysis. Read [SECURITY.md](SECURITY.md) for vulnerability reporting and security details.

## Checks

```powershell
npm test
npm run build
npm audit --prefix backend --omit=dev
npm audit --prefix frontend
```

## Project layout

- `backend/` — loopback API, Git integration, workspace boundaries, and optional S3 backup service.
- `frontend/` — React interface and Vite configuration.
- `scripts/` — local development launcher.
- `docs/architecture.md` — runtime and data-flow overview.
- `.github/workflows/` — CI, CodeQL, and secret scanning.

## License and use

The source is public so people can study it and try it for permitted noncommercial purposes. It is licensed under **PolyForm Strict 1.0.0**, with Jeet Tiwari as licensor. The license does not grant permission to distribute the software or make changes or new works based on it. Public visibility does not remove those limits, and the license does not make the source technically secret. Read the full terms in [LICENSE](LICENSE) or the website copy [LICENSE.txt](LICENSE.txt). Third-party dependencies keep their own licenses.

The project page is available at [jeettiwari2107.github.io/Exploring-Tech](https://jeettiwari2107.github.io/Exploring-Tech/). It is a static information page; clone this repository and follow the steps above to run the app locally.
