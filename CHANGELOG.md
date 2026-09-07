# Changelog

All notable changes to this project should be documented in this file.

This project follows semantic versioning after the first public release.

## 1.3.0 - 2026-09-07

ABot 1.3.0 adds native scheduled Jobs, explicit memory recall, and richer
Web UI feedback.

### Added

- The Web UI opens on a Home dashboard with recent Job activity, recent
  conversations including unread messages, and shortcuts for attachments,
  Jobs, conversations, and configuration. Its shared composer starts a new
  conversation while keeping the existing Chat draft separate. Empty activity
  offers editable Job templates that create dedicated conversations on Save.
- Native one-time and recurring Jobs persist their task, model, and mode, with
  a built-in schedules capability and Web UI management and run history.
  Jobs run while the local runtime host is active; missed offline occurrences
  are recorded without being backfilled.
- Supervisor and Execution Agent can request focused long-term memory recall
  and continue the same root decision when memory is enabled.
- Chat messages render Markdown tables, nested lists, quotes, code, and clickable
  links, with bounded, cached rich link previews.

### Changed

- Local runtime applications share scheduler ownership, with isolated storage
  for named environments and durable scheduling history.
- Tool Activity uses compact evolving rows with executor attribution, expandable
  recorded input/output, and distinct partial, empty, unchanged, and failed
  outcomes.
- Live activity text describes the current phase below assistant content;
  animation respects reduced-motion preferences and stays static during approval
  waits or disconnections.
- The Jobs workspace uses compact rows, defaults to active and paused Jobs,
  opens the first visible editor, and refreshes lists without replacing drafts
  or losing matching selections.
- Web UI typography is slightly smaller while mobile and touch form controls
  retain readable sizing.
- Explicit memory recall has a configurable per-request limit through
  `longTermMemory.maxRecallCallsPerRequest` (default: 5). Reaching the limit
  preserves retrieved context and allows normal request continuation.

### Fixed

- Direct Supervisor responses retain a bounded recommendation from the accepted
  routing decision and discard superseded response preparation after steering.
- Scheduled requests carry their Job and run origin into root decisions and
  response authoring. Scheduling descriptions distinguish reminders from tasks
  the runtime should perform.
- Memory recall continuations preserve the accepted lookup, linked result, and
  ordering relative to completed child calls, including after compaction.
- Activity summaries highlight only the failure count, and rejected tool
  preparations or executions settle their correlated lifecycle.

## 1.2.0 - 2026-09-04

ABot 1.2.0 focuses on stronger delegated-work handoffs, bounded web search,
and clearer execution visibility in the Web UI.

### Added

- Light web search works without a Brave API key, using a bounded catalog of
  public sources and local relevance ranking. Coverage is limited to those
  sources; a configured Brave search does not fall back to Light on failure.
- Supervisor routing receives a budgeted, passive capability overview derived
  from the same available-capability registry used by the capability brief.
- A current-turn Planning drawer in the Web UI shows plan items and progress
  above the composer.
- Compact role activity and role avatars make active delegated work visible
  without expanding the full Activity view.
- Web-source receipts and compact source links in Activity distinguish returned
  content, snippets, references, omitted output, and failed fetches. They describe
  bounded tool output, not proof that the model read or cited a source.
- Conversation history can copy a session's exact filename for support and
  troubleshooting.

### Changed

- Model selection and reasoning-depth controls now sit in the Web UI composer,
  with an updated responsive layout and accessible control labels.
- Conversation history stays docked on wide screens, while Runtime, Logs, and
  Health tools are grouped under Configuration's Operations view.
- Web UI typography and responsive spacing improve conversation readability;
  history rows use compact titles instead of expanded metadata.
- Context usage is presented as a compact indicator in the Web UI composer.
- Planned Work assigns exactly one production plan item per Worker invocation;
  Supervisor owns subsequent review delegation.
- Delegated Planner and Worker results carry runtime-owned provenance receipts
  that preserve their producing call and work lineage across continuations.
- Development tooling is updated, with additional regression coverage for
  blocked Planner handoffs.

### Fixed

- Planner-owned Workers retain their exact assignment, working directory, and
  relevant dependency artifacts across decision, payload, and result authoring.
- Planner-led changes to existing projects keep bounded target discovery within
  the implementation task, preserving canonical project paths and avoiding
  redundant inspection when current target context is already supplied.
- Planner receives the complete available capability-group catalog, including
  descriptions and declared effects, when scoping delegated work.
- Reviewer receives the canonical completion target and exact delegated results;
  structured verdicts preserve reported gaps across role handoffs.
- Reviewer audits require coverage of supplied evidence and multi-target mutation
  verification, and reject pass verdicts that contradict their own findings.
- Ollama structured output no longer receives an artificially low token ceiling
  derived from JSON schema size. Physical-context and core-decision limits remain
  in effect.
- Complete system-probe requests avoid an unnecessary controls-refinement step.
- Gateway request decoding preserves UTF-8 characters split across incoming
  chunks, keeping token measurements bound to the exact request content.
- Web UI tool counters count actual invocations, and context usage from the
  previous request stays hidden while a new request is pending.
- Planning drawer state survives failed-session restoration, steering, and
  overlapping live and replayed progress updates.
- Execution guidance preserves existing resources during creation and calls for
  clarification when a mutation target or scope remains ambiguous after required
  read-only discovery.

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
