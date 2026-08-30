# Changelog

All notable changes to this project should be documented in this file.

This project follows semantic versioning after the first public release.

## Unreleased

## 1.1.0 - 2026-08-30

ABot 1.1.0 focuses on upgrade-safe configuration, optional cross-session
memory, and stronger execution evidence.

### Added

- Optional passive long-term memory across sessions, disabled by default, with
  OpenAI and Ollama embedding support, bounded retrieval and background
  persistence, CLI and Web UI onboarding, and record management.
- Request Runner Config v2 with sparse model-step routing overrides, a shared
  step timeout default, and sparse per-step timeout and instruction settings.

### Changed

- Fresh initialization writes Config v2 while preserving existing local config
  files unless replacement is explicitly requested.
- The Config workspace has been redesigned with visible Supervisor/Worker and
  Execution Agent routes plus safer load, edit, save, and environment
  transitions.
- Capability execution now preserves the selected action and objective through
  payload authoring, execution, and returned evidence, with bounded supervision
  before execution and across repeated operations.
- Public Git and npm artifacts are generated from the same verified snapshot.

### Fixed

- Provider adapters preserve an explicit `reasoningEffort: "none"` end to end;
  OpenAI sends it as `reasoning.effort: "none"` instead of omitting it and
  allowing provider defaults to silently re-enable reasoning.
- Legacy 1.0.0 request-runner configs without `schemaVersion` remain usable
  without migration or automatic file rewrites when new model steps are added.
- Repeated or refined capability selections, pending Worker execution, payload
  objectives, and tool-result evidence remain bound to the exact accepted
  operation, with bounded handling for non-progress loops.
- Exec filesystem mutations are included in the returned tool-result evidence.
- Final responses no longer emit stale deferred acknowledgements.

## 1.0.0

- Initial public runtime library surface.
- Public runtime config schema and sanitized example config.
- Source checkout init flow through `npm run init`.
- Runtime plugin contract and example plugins.
