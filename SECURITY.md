# Security Policy

## Supported Versions

Security fixes are prepared against the current main branch until a formal
release support policy is published.

## Reporting A Vulnerability

Do not open a public issue with secrets, exploit details, credentials, private
URLs, or live service tokens.

Report suspected vulnerabilities privately to
[security@dorshitrit.com](mailto:security@dorshitrit.com). Include:

- affected version or commit
- a concise reproduction
- impact and affected runtime surface
- whether any secret, token, or private data was exposed

## Secret Handling

Runtime secrets must stay in environment variables, host secret stores, or
deployment-specific service configuration. Do not commit `.env`,
`runtime.config.json`, `local/runtime.config.json`, `.runtime/`, logs, session
state, memory state, sandbox output, or generated build artifacts.
