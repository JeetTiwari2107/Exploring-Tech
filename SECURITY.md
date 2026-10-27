# Security policy

LocalGit Studio is designed to run on the developer's machine and bind only to the loopback interface. It is not intended to be exposed to a LAN or the public internet.

## Supported versions

Security fixes are made on the default branch. Use the latest released version when one is available.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting feature for this repository when it is available. Do not include exploit details, credentials, session cookies, private repository URLs, or user data in a public issue. If private reporting is unavailable, contact the maintainer through their GitHub profile and request a private reporting channel without publishing technical details.

Include the affected component, impact, reproducible steps, and any suggested mitigation. This project has no guaranteed response-time commitment.

## Security design notes

- The API accepts an explicit local root and does not expose shell execution, arbitrary Git commands, or arbitrary file reads.
- Git subprocesses use fixed argument arrays, noninteractive credentials, output limits, and timeouts.
- S3 credentials use the AWS SDK provider chain on the local process. The browser never receives credentials or signed URLs.
- S3 restore previews bind overwrite confirmation to exact repository-relative paths and verify content hashes before writing.
- `.env`, SSH keys, AWS settings, and local database data from earlier app versions are excluded and must not be used in tests.
