# Open-Source Projects & Tech Explorations

This directory houses open-source projects, experiments, and technical explorations maintained by **Jeet Tiwari** (`@JeetTiwari2107`).

## Project Index

| Project | Location | Focus | Status |
| :--- | :--- | :--- | :--- |
| **LocalGit Studio** | [`/`](../) | Local-first Git workspace alongside VS Code with optional S3 backup | Active |
| *Upcoming Projects* | [`./<project-name>/`](./) | New open-source tools, AI/data experiments, and utilities | Planned |

## Standard Project Structure

When adding a new open-source project under `projects/<project-name>/`, follow this layout:

```text
projects/<project-name>/
├── README.md          # Overview, setup, usage, and architecture
├── LICENSE            # Open-source license (if different from root)
├── .gitignore         # Ignore build artifacts, dependencies, and secrets
├── .env.example       # Documented environment variables (never commit .env)
├── src/               # Source code
└── tests/             # Unit and integration tests
```

## Checklist Before Adding a New Project

- [ ] Include a clear `README.md` with setup and usage instructions
- [ ] Ensure no API keys, tokens, or `.env` files are committed
- [ ] Add tests or verification steps
- [ ] Update the **Project Index** table in this file and in the root [`README.md`](../README.md)
