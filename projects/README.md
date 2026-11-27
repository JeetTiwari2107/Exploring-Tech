# Open-Source Projects & Tech Explorations

This directory is the structured workspace for new open-source projects and technical explorations in `Exploring-Tech`.

## Project Index

| Project | Path | Description | Status |
| :--- | :--- | :--- | :--- |
| **LocalGit Studio** | [`/`](../) | Local-first Git workspace for managing real repositories on disk alongside VS Code, with optional personal S3 backups | Active |
| **New Project Template** | `projects/<project-name>/` | Placeholder for upcoming open-source tools, experiments, and utilities | Planned |

## Standard Per-Project Folder Convention

Each new project added under `projects/` should follow this layout:

```text
projects/
└── <project-name>/
    ├── README.md        # Project overview, setup, usage, and architecture notes
    ├── LICENSE          # Open-source license (matches or complements root LICENSE)
    ├── .env.example     # Sample environment variables (never commit real secrets)
    ├── .gitignore       # Project-specific ignore rules
    ├── src/             # Source code
    └── tests/           # Automated tests
```

## Adding a Project

See [`CONTRIBUTING.md`](../CONTRIBUTING.md) for guidelines on proposing, structuring, testing, and submitting a new project or contribution.
