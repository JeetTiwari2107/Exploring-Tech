# Contributing to Exploring-Tech

Thank you for your interest in contributing to **Exploring-Tech**! This repository serves both as the home of **LocalGit Studio** and as a structured hub for open-source projects and technical explorations.

## Ways to Contribute

1. **Improve existing projects** (e.g., `LocalGit Studio` at the repository root)
2. **Add a new open-source project** under [`projects/<project-name>/`](./projects/README.md)
3. **Report bugs or suggest features** using the issue templates in `.github/ISSUE_TEMPLATE/`

## Adding a New Open-Source Project

1. Create a directory under `projects/<project-name>/` (use lowercase `kebab-case`).
2. Include at minimum:
   - `README.md` (purpose, prerequisites, setup, and usage)
   - `.gitignore` and `.env.example` (if configuration is required)
   - `src/` and `tests/`
3. Register the project in:
   - [`projects/README.md`](./projects/README.md)
   - The **Open-Source Projects & Explorations** table in the root [`README.md`](./README.md)

## Pull Request Workflow

1. Fork the repository and create a feature branch (`feat/<short-name>` or `fix/<short-name>`).
2. Keep changes focused and well-documented.
3. Run relevant tests and linters before opening a PR.
4. Never commit secrets, credentials, `.env` files, or private data.
5. Complete the Pull Request template checklist.

## Community & Security

- Please follow the [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md).
- To report a security vulnerability, follow [`SECURITY.md`](./SECURITY.md) instead of opening a public issue.
