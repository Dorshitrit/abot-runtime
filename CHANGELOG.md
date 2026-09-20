# Changelog

All notable changes to this project should be documented in this file.

This project follows semantic versioning after the first public release.

## 1.4.0 - 2026-09-20

ABot 1.4.0 adds guided setup, project conversations, FULL+ system access,
and connections from Docker to applications on the host computer.

### Added

- Guided Web UI setup for OpenAI or Ollama, optional embeddings, and plugin
  selection. Additional models can reuse saved provider connections while
  preserving existing profiles and the default model.
- Configuration controls for installed plugins and individual tools, with
  saved selections applied to idle Runtime environments.
- Conversation file previews and downloads from Activity when the filesystem
  provides a stable working-folder identity. Supported documents can also open in their
  default application on a locally connected Mac.
- Projects group conversations above ordinary sessions and use independently
  selected working folders. Creating a project does not change the configured
  default workspace or introduce a permissions sandbox.
- FULL+ mode enables task-relevant application discovery, launching, and system
  commands without additional ABot approval prompts. Ask and Full request
  approval for each prepared system action; Full recommends FULL+ for future
  actions. Operating-system permissions still apply, and disabled tools remain
  unavailable in every mode.
- Guided computer access connects a Docker Runtime to its Windows or macOS host
  through a native companion, with automatic pairing, connection status, and
  disconnection controls. Chat offers setup guidance when required access is
  missing; working native access needs no companion installation.
- A Windows setup script repairs unavailable WSL interop, preserves unrelated
  settings, and automatically restarts only the selected distribution without
  a typed restart confirmation. The setup screen explains the interruption
  before download, and access is verified after the restart.
- Execution Agent planning can report an explicitly adopted plan and item
  progress through the existing Web UI plan display, without extra model
  decision turns for status updates.

### Changed

- New conversations remember the user's last explicit permission-mode selection
  in the browser, including FULL+. Existing conversations retain their own mode.
- Activity and approval cards expose recorded system commands, arguments,
  operating-system target, working directory, and elevation details.
- Connected-computer capabilities are offered only when available. Connection
  identities stay internal, and prepared actions remain bound to their target
  through approval and execution.
- Execution Agent guidance favors planning and independent review for complex
  development, including sequential work on a single integrated application.
  A selected working folder does not authorize overwriting an existing app;
  new-app requests call for a distinct destination or target clarification.

### Fixed

- Long Worker activity descriptions are bounded without aborting otherwise valid
  capability actions, preserving complete Unicode characters.
- System launch guidance clarifies platform-specific argument support and avoids
  treating an unverified application outcome as a reason to repeat the action.
- Delegated Planner reuses the same canonical capability descriptions and
  context-budget admission as Supervisor, including structured-output repairs,
  replacing its separate aggregate-tag catalog without changing tool scopes.
- Supervisor routing receives canonical operation descriptions and available
  execution targets when the complete catalog fits its context, so delegation
  does not rely only on tool names. Compact fallbacks preserve complete coverage
  and explicitly identify omitted detail. Routing retries reselect this optional
  brief so structured-output repairs retain their required input capacity.
- Setup and configuration edits preserve provider selections, credentials, and
  model profiles across retries. Configuration saves coordinate concurrent
  changes and keep recovery available for malformed configuration files.
- Background computer-status checks preserve the configuration view and avoid
  repeated rendering when the displayed state has not changed.
- The Jobs workspace keeps content and feedback within a consistent width.
- Execution Agent audits select their own whole original evidence from a
  complete work inventory and can request another evidence bundle. Prior
  advisory summaries no longer crowd out work evidence, and unchanged
  completed reviews are not repeatedly offered. Exact duplicate proof is sent
  once, and evidence admission uses the configured model context budget rather
  than a fixed character limit. Completion-review guidance avoids routine audits
  after each edit and keeps unperformed functional tests visible as gaps.
  Both passing and gap verdicts require the original evidence the auditor marks
  as needed; replacement bundles must retain all such evidence. Plan adoption
  schemas bind each task ID to its selected Planner proposal.
- EXEC uses declared sensitivity instead of parsing shell commands for permission
  decisions. Execute, wait and cancel ask for exact-action approval in Ask/Full
  and run automatically in FULL+. Approved commands retain their original text
  and can use any existing cwd accessible to the OS user. Approval cards show
  the complete command/cwd or process controls; disabled tools stay unavailable.
- Ambiguous Dev View locators report bounded candidate line ranges and concrete
  numeric controls instead of leaving the caller without observed locations.

## 1.3.1 - 2026-09-07

### Fixed

- Initialization creates the configured working and storage directories for
  each environment and preserves existing configuration and custom paths.
- File creation, editing, directory inspection, local search, and shell
  commands now work on macOS while retaining path containment, atomic writes,
  and process cancellation safeguards.

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
