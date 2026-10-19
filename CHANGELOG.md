# Changelog

All notable changes to this project should be documented in this file.

This project follows semantic versioning after the first public release.

## 1.9.0 - 2026-10-19

ABot 1.9.0 adds reusable personal Skills and a dedicated Skills workspace,
improves Studio run history, and strengthens continuity during longer tasks.

### Added

- Discover and read built-in Skills for ABot Studio, Computer Use, Skill Creator
  and Technical Work when their guidance is relevant. Skills can be read by name
  or ID, with up to eight documents in one call.
- Ask ABot to create or update personal Skills for recurring tasks. Saved Skills
  are shared across conversations and models within the same Runtime environment;
  concurrent edits are checked to prevent overwriting another saved revision.
- Manage personal Skills in a new Web UI workspace: create, edit content, archive
  and restore. Built-in Skills remain read-only, and archived personal Skills are
  excluded from new discovery and reads.
- Expandable Supervisor cards show the objectives of delegated work, and Planner
  cards show returned results or failures. Recorded details remain available when
  reopening the conversation.

### Changed

- Studio run history supports status and calendar-date filters, 50-record pages,
  automatic loading while scrolling, and a Load more button. Navigation preserves
  the loaded history, and Run or Run again refreshes it before opening the report.
- Supervisor can read Skills directly and pass captured guidance through planning,
  execution, review and completion audits, including after context compaction.
  Ordinary Skill reads no longer require per-action approval in ASK mode;
  explicit tool blocks, forced approvals and write permissions still apply.
- Supervisor now handles requested personal Skill creation and updates directly,
  using relevant conversation, attachments and completed work as source material.
  Updates retain the complete existing document and checked revision through
  context compaction; approval resume saves the previously prepared content.
- Shorter agent instructions and deduplicated tool-result content reduce repeated
  context. Guidance emphasizes reusing established results, preserving task
  requirements and respecting later user instructions, including requests to stop.
  Missing evidence is distinguished from work the user still requires.
- Technical Work guidance favors focused implementation and verification, with
  broader browser or UI testing reserved for explicit requests. Computer Use
  guidance calls for explicit approval before discovering, observing or controlling
  a computer, while retaining approval already given for the same target and task.
- Newly configured Ollama profiles receive tailored defaults for token estimation
  and context compaction. Existing profiles are not automatically changed.

### Fixed

- Supervisor follow-up tasks retain exact paths to previously created artifacts,
  including directory names that begin with a dot.
- Provider and transport failures in delegated model calls return a failed result
  to their caller instead of automatically failing the entire request.
- Available Skills no longer disappear because of an early context-budget
  estimate. Missing Skill lookups display a clear "Skill not found" activity.
- Context compaction is interrupted when the user updates an active request,
  so continuation uses the current input.
- Switching Runtime environments no longer overwrites the destination
  environment's remembered model selection with the previous environment's model.
- Concurrent Web UI state saves no longer trigger the lock conflicts seen
  on Windows.
- Repeated tool-group selections no longer cause otherwise valid Supervisor or
  Planner delegation decisions to fail validation.
- Context-compaction deadlines are identified as timeouts in failure diagnostics
  instead of being reported as rejected checkpoints.
- Newly initialized environments use a 180-second context-compaction timeout
  instead of the general 90-second step timeout. Newly configured OpenAI profiles
  receive a five-minute compaction timeout through CLI or Web setup, unless the
  template specifies one. Existing runner and model configurations are not
  automatically migrated.

## 1.8.1 - 2026-10-14

ABot 1.8.1 improves request reliability, memory-informed decisions, tool discovery
and planning, with a more compact Home experience on smaller screens.

### Changed

- Execution Agent can return an eligible short answer and memory candidates in
  one model call. Automatic long-term memory is prepared before its first
  decision and reused through tools, steering and saved approval resume.
- Supervisor receives automatic long-term memory before its first routing
  decision and retains that reference through the existing request lifecycle.
  Explicit memory recall remains available in both execution modes.
- Execution Agent, Supervisor and Planner use a compact, group-first tool
  catalog with exact plugin/tool membership and optional short plugin
  descriptions. Detailed operations appear after the relevant group is opened.
- Supervisor chooses an available Planner when remaining execution requires
  multiple steps across at least two different tools. Planner guidance is
  streamlined while preserving requested tools and Worker execution ownership.
- Home uses compact widgets at widths up to 1440px, with previews for activity,
  conversations, approvals, runs, automations and computer access. Opening a
  widget shows its existing live panel in a scrollable dialog; wider screens
  retain the full layout.
- The interface displays the existing Fast reasoning mode as Low. Stored and
  API values, effort mapping and defaults remain unchanged.
- Refresh the README around practical local workflows, Execution Agent,
  Supervisor and Studio, with clearer Windows support boundaries.

### Fixed

- A steering update arriving during saved tool-approval resume no longer fails
  the request. The original approval or rejection is preserved, superseded
  execution is fenced, and the update reaches the existing continuation once.
- An abrupt Ollama disconnect during streamed output no longer crashes the
  Gateway by attempting a second HTTP response. The request fails explicitly,
  partial output is not accepted, and the same process can serve later requests.
- EA no longer loses its direct-answer option because of a conservative context
  estimate. Actual context admission, provider token counting and compaction
  still enforce the configured limits.
- Initial EA memory preparation preserves supported conversation text and
  attachments, filters request-local tool evidence, and ignores undeclared
  memory-reference fields before saving context.
- Compact Home widgets preserve live component state, drafts, actions and focus
  when opened and closed. Computer previews include accessible name and OS
  descriptions, and opening SPARK chat focuses its input.

## 1.8.0 - 2026-10-12

ABot 1.8.0 adds native Windows support to the Runtime library and its bundled
public plugins, installation-wide Web UI preferences and queues, and improvements
to model output handling, tool evidence and conversation controls. Native Windows
support is included in the library release; desktop and Microsoft Store packaging
remain a separate release path.

### Added

- Run all bundled public plugins on native Windows, including filesystem access,
  command execution, local search, document reading, code and project inspection,
  memory and web access. Existing permissions and approvals still apply. SYSTEM
  supports local commands and application listing/launching; native Windows
  desktop observation and input (`computer_*`) remain unavailable. See
  [native Windows plugin support](docs/plugins.md#native-windows-plugin-support)
  for operation-specific requirements and limitations.
- Declare plugin compatibility with the Runtime host's operating system. The
  loader checks compatibility before loading plugin code, and plugin views explain
  unsupported platforms while preserving saved selections and configuration.
- Collect SPARK activity locally on native Windows without Companion pairing,
  with explicit collection consent and the existing permission, schedule and
  Start/Stop controls.
- Save Web UI preferences and Send next queues with the ABot installation across
  browsers and local server addresses. Ordinary unsent drafts remain local to
  their window.
- Extend the plugin SDK with bounded native Windows file reading and
  `mutationSuccessResult()` for changes already confirmed by the owning plugin.

### Changed

- Reasoning selectors in Chat, Schedules, SPARK chat and Studio now reflect the
  active model's reasoning-control permission. Chat offers a compact prompt to
  enable it immediately when idle or save it for the next Runtime start.
- OpenAI capability controls use native function calling with the existing
  validation, permission checks and execution authority.
- Execution Agent context avoids repeated capability descriptions and work-plan
  schemas, with clearer capability selection and Planner handoff guidance.
- Provider failure diagnostics retain bounded partial responses and stream
  timing details, including when the provider fails before completing a response.
- Memory review markers retain only the latest reviewed revision of each memory,
  are bounded to 200 records per environment, and retire confirmed deletions.

### Fixed

- OpenAI decisions and file payloads use the final answer without preceding
  commentary, reject incomplete responses, and finish at accepted completion
  events without waiting for the connection to close. FAST mode no longer applies
  a separate output limit that could truncate otherwise valid results.
- Ollama provider errors and missing completion markers fail explicitly instead
  of allowing partial output to be accepted as complete.
- Execution Agent decisions and replies use the Runtime's recorded tool outcome
  and exact result evidence. Pending approvals retain their original tool evidence
  when restored after an upgrade.
- Steering reaches the owning request after a saved approval wait, with consistent
  conversation controls during request-state transitions.
- Chat, Home and SPARK share ownership of complete drafts and submissions. Text
  and files stay with their originating conversation during navigation or a
  rejected send. Unconfirmed sends remain separate for explicit manual review;
  ordinary sends do not wait for unrelated preference writes.
- Model and connection setup recover interrupted configuration changes, and
  context-window errors appear beside the relevant setup field.
- Native Windows file operations preserve protected access and storage metadata,
  coordinate writes across path case variants, and clean interrupted writes.
  Memory operations handle Windows lock contention; EXEC cancellation contains
  descendant processes and SYSTEM commands use the authorized working directory.
- File creation guidance distinguishes files from directories and ordinary edits
  from complete replacement. An existing file blocking a parent path reports a
  clear directory error.
- SYSTEM and Companion protect observed content before delivery by masking
  detected secret indicators and withholding associated desktop images.
- Closing SPARK cancels pending openings without late navigation or focus changes.
  SPARK excludes the ABot desktop application from collection and its application
  controls.
- Marketplace installation links on macOS handle the native URL event and open
  the paired Runtime's plugin review screen. Installation still requires review
  and confirmation.

### Upgrade notes

- Existing browser-only preferences and Send next queues start fresh once;
  conversations, memories, configuration and read status are retained. Tool
  permissions default to Ask until explicitly changed.
- Every installation, including existing installations on all platforms, needs a
  one-time SPARK collection acknowledgment. The acknowledgment is retained across
  updates and re-pairing; collection and learning remain separately controlled.
- Update existing Companion installations before using SYSTEM operations that
  require the new host-side secret protection. Unsupported Companion versions
  are rejected before dispatch. Existing Mac connections also need their
  installation-link handler refreshed; see the
  [macOS connection instructions](docs/installation.md#macos).

### Development

- Add Windows compatibility CI and require explicit requests for private PR CI.
- Add an internal native Windows desktop QA shell with startup diagnostics,
  saved workspace state and managed process shutdown. The shell is not included
  in the public snapshot or npm package; Store packaging remains separate.

## 1.7.0 - 2026-10-09

ABot 1.7.0 adds community plugin installation and configuration, per-model tool
access controls, paginated conversations, and guided Windows computer connection
through ABot AI Companion on Microsoft Store.

### Added

- Install community plugins from public GitHub repositories through Plugins.
  Review resolves the chosen source to an exact commit and shows its tools and
  configuration before installation. Discover links to the ABot Marketplace;
  Companion can open `abot://install` links in Discover with the plugin source
  ready for review.
- Configure declared plugin settings and secrets during installation and later
  from Plugins. Values stay local, are shared across environments, and are
  retained after Remove. Apply loads saved values into idle Runtime owners.
- Remove plugins installed through the GitHub installation flow after disabling
  and applying the change to idle Runtime owners. Settings, secrets and plugin
  data stored outside the installed package are retained.
- Restrict plugins and individual tools for each model profile from Models.
  The selected primary profile's restrictions apply throughout the request,
  including delegated roles and approval resumes. Global restrictions still
  apply; toggling a plugin preserves its individual tool choices.
- Paginate session lists, conversation history and SPARK, with
  `webUi.pageSize` defaulting to 20. Older history remains accessible while
  active requests continue.
- Connect Windows computers through
  [ABot AI Companion on Microsoft Store](https://apps.microsoft.com/detail/9PK2FDQQLQS9).
  The guided flow opens Companion with a temporary invitation and requires
  explicit consent before pairing. Paired computers can reopen their saved
  connection or start a confirmed setup again.

### Changed

- Conversation lists use a metadata index instead of loading every conversation's
  full history. Streaming updates maintain the index with bounded writes.
- Computer Access uses shared compact connection cards across Windows, macOS
  and Linux, with clearer connection status and explicit Microsoft Store
  installation and update buttons on Windows.
- Models, Plugins and Operations show summaries specific to the selected page
  and environment, with explicit loading and unavailable states. Configuration
  controls and SPARK action buttons use consistent styling.
- The Web UI and documentation link to the official ABot website at
  `abot-ai.com`; security reports use `security@abot-ai.com`.
- STEER lifecycle diagnostics correlate request-control activity across Web UI,
  Bridge and Runtime without changing steering behavior.

### Fixed

- Local SYSTEM commands retain complete stdout and stderr on disk and deliver
  large text through the existing context admission contract. Output failures
  preserve the process receipt.
- Updated Companion installations transfer large SYSTEM command output in
  verified chunks without repeating execution after transfer failure. Captures
  preserve their configured retention across reconnects.
- Paged conversations preserve saved sidebar order, links to older runs, active
  request activity, live reply order and visible-page read tracking. Failed
  Latest loads keep the current page; programmatic scrolling does not fetch
  extra pages, and direct links work beyond the first session page.
- Web setup reports the effective context-window requirement when model capacity
  cannot cover configured reserves, with actionable feedback on the context field.
- Runtime configuration status and edits resolve absolute configuration paths
  consistently with loading, including paths saved by Web onboarding.
- Computer Access and SPARK wait until onboarding completes. Late responses
  cannot reopen them after returning to setup, while ordinary refreshes of a
  configured environment preserve computer access and the open SPARK conversation.
- Whole-plugin disable and removal use exact plugin IDs independently of tool
  selectors. Reinstall clears only the target plugin's exact disable while
  preserving existing tool restrictions and other plugins' policies.
- Plugin installation, selection saving, removal and rollback coordinate with
  Apply. Removal preserves directories replaced during deletion; reinstall
  clears package-local module caches. The UI reflects active environments and
  pending changes after a partially completed removal.
- Plugin configuration preserves retained values and inherited defaults.
  Failed installation keeps editable settings, changing the source clears secret
  drafts, and redundant default resets do not create unsaved changes. On POSIX,
  local plugin credential files require owner-only permissions. Secret values
  are not returned to the UI.
- Plugin-only Apply can retain an externally managed local model gateway when
  its configuration matches every active Runtime snapshot. Changed or unknown
  gateway configuration still requires explicit service activation.
- Companion pairing serializes invitation setup, requires consent before a new
  grant is consumed, and preserves the matching saved host identity during an
  upgrade. Existing pairings can register Marketplace install links by updating
  Companion without unpairing.
- Studio draft authoring distinguishes substantive text from structured output
  and metadata through compact declarations for selected operations, without
  repeating Studio guidance in ordinary tool descriptions.
- Update `source-map-js` from 1.2.1 to 1.2.2.

### Development

- Synchronize SPARK proactive tests with review and filesystem completion to
  avoid timing-dependent failures.

## 1.6.0 - 2026-10-05

ABot 1.6.0 introduces ABot Studio for reusable automations and a persistent
SPARK conversation. It improves tool execution, context compaction, setup, and
macOS computer access.

### Added

- ABot Studio combines tool and agent steps in sequential and parallel workflows,
  with connected inputs, structured results, reusable saved agents, and starter
  templates for research, documents, development, and operations. Agent steps
  support text or validated JSON results, required tools, acceptance checks,
  and stop-or-skip failure handling.
- Automations support manual runs, schedules, and folder polling with file
  filters and per-file or batch processing. Runs capture the published workflow,
  selected inputs, source snapshots, and resource limits for later inspection.
- Studio provides a visual workflow editor, draft validation, revision checks,
  explicit publication and activation, Full or FULL+ tool permissions, pause and
  stop controls, and archive/restore. Restored automations remain paused.
- Conversations can create and edit connected automation drafts through the
  configured tool catalog. Draft authoring does not grant permissions, publish,
  activate, or run a draft.
- Run views retain step outputs, tool receipts, reports, and recorded effects,
  with source links from Home, conversations, and notifications. Explicit reruns
  use the retained run definition and inputs after confirmation, and recheck
  current permissions and dependencies.
- SPARK has one persistent companion conversation per environment, with its own
  popup, attachments, permissions, and Fast/Reasoning/Deep chat settings. It uses
  the selected Proactive model and starts with Ask permissions. Ordinary
  conversations and their drafts remain independent.
- Proactive suggestions appear in the SPARK conversation. Saved suggestions can
  open a regular work conversation with their retained context. Repeated opens
  reuse the same conversation; opening it does not start work automatically.
- The SPARK launcher can be moved with a pointer or keyboard, and its position is
  saved in the browser. The popup stays within the viewport and respects reduced
  motion settings.
- Computer setup and Home provide separate Screen Recording and Accessibility
  checks and explicit permission requests for the Mac Companion and the active
  Runtime's native SYSTEM route. The CLI adds `abot host permissions` with
  optional requests for each permission. Checks do not start Spark collection.
- Plugin results can declare text fields for context admission separately from
  metadata, with invocation-aware result budgeting. Declared text still follows
  model context limits. The ordinary SDK result allowance increases from 128 KiB
  to 256 KiB, and metadata for declared text remains bounded to 256 KiB.
- Plugin operations can declare `attachmentInput` parameters and accepted MIME
  types for Studio file sources. Explicit single-stage payload schemas reach
  both root and Worker payload authors. Plugin failure results can report
  `interruption: "aborted"` while retaining their original error code.

### Changed

- Web UI workspaces use consistent headers. Notifications opens on Unread and
  separates its inbox and settings into tabs, with paging and clearer empty,
  loading, and error states.
- Studio editing separates draft, execution, and management actions. Step editors
  preserve unsaved changes, support schema-aware inputs, and provide guarded move
  undo and reset-to-published controls. Live updates preserve the selected run,
  expanded details, and scroll position across background refreshes.
- The automation library separates Published automations from Drafts, displays
  each automation's last edit time, and sorts each group and the archive by the
  most recent edit first.
- Schedule opens the first visible job's details and action buttons. Editing
  remains an explicit action.
- SPARK suggestions are read in the companion conversation. The old Home and
  Spark suggestion cards and Keep/Not interested actions have been removed.
  The shared mint spark mascot reflects active work and settles while
  disconnected or awaiting approval; Jobs identifies the persistent conversation
  as **SPARK Chat**. The compact popup hides scheduled-task invocation cards
  while retaining task replies and the normal conversation's schedule view.
- Successful Embedding setup in Web onboarding enables native memory and
  disables the separate Memory plugin in the same configuration save, retaining
  existing plugin data and unrelated preferences. Skipped or failed setup leaves
  plugin selection unchanged.
- Run reports initially open the first step and its evidence. Conversation
  Activity shows Studio authoring actions with automation identity and relevant
  revision, step, and tool details.
- Automation start and terminal notifications link to saved run reports.
  Internal agent sessions do not generate duplicate conversation-reply alerts.
- Model settings label reasoning support as **Supports reasoning controls**.
  Disabling these controls leaves the provider's reasoning defaults in effect.

### Fixed

- Automation authoring preserves connected payloads and agent assignments,
  validates complete draft batches and their receipts before saving, and prevents
  partial writes or stale draft updates. Drafts whose complete authoring receipt
  exceeds capacity save no changes.
- Automation runs retain specific failure causes, resource-limit explanations,
  blocked outcomes, and uncertain tool effects. Reports distinguish an attempted
  tool invocation from confirmed execution, including cancellation and timeout;
  late tool evidence is retained without rewriting a settled uncertain outcome.
- Automation agent steps use isolated sessions with their selected tools and
  result schema. Temporary transcripts and attachments are cleaned up after
  execution; restart reconciles abandoned sessions and source preparations while
  preserving run evidence. Interrupted runs are not automatically replayed.
- Republishing an automation without changing its timing preserves timer
  deadlines and interval or folder-polling cadence. New or changed one-shot
  schedules in the past are rejected before publication.
- Run now and Run again show **Starting** and prevent duplicate starts while the
  request and navigation complete. Delayed responses after changing environments
  or views cannot replace the current selection.
- Folder intake retains bounded deduplication history and reports capacity
  exhaustion instead of forgetting old file versions and processing them again.
- Studio authoring catalogs distinguish permissions for future workflow runs
  from the current conversation's authority. They identify whether the catalog
  is for a new automation or a specified automation's permission scope. Draft
  authoring does not grant execution permissions.
- File operations reject foreign or ambiguous path namespaces, including after
  dot-segment normalization, before preparing or writing a target. Execution
  Agent and Supervisor workflows receive the request-bound filesystem root when
  selecting directories and file paths.
- EXEC retains complete stdout and stderr on disk with bounded pipe buffers.
  Declared text is admitted through runtime context budgets separately from
  delivery metadata. Tool catalogs describe the 8,192-character command limit
  and file payload semantics.
- EXEC retains unaccepted output and process receipts across approval waits
  within its configured retention period. Periodic cleanup expires abandoned
  output while protecting active readers and writers. Concurrent waits and
  cancellations claim terminal delivery once; rejected presentation leaves
  output available for a later observation. Storage and expired-output failures
  retain the process identity and do not replay the command.
- Tool payload authoring preserves the selected operation objective during direct
  Execution Agent execution, including batches. Structured JSON payloads reject
  duplicate member names before tool execution.
- Supervisor workflows preserve canonical tool and delegated-role evidence
  through compaction and saved approvals. Invalid checkpoints are isolated
  without discarding healthy evidence.
- Context admission can compact conversation history and then active-request
  context when the first reduction is insufficient, including with smaller model
  windows. The final input must satisfy existing context limits before retained
  reductions are committed, while preserving cancellation and steering behavior.
- Execution Agent selects the canonical tool results needed to complete an
  operation's remaining parameters, including batched invocations. Unselected
  earlier results stay out of Controls input, and compaction remains bound to
  the selected assignment.
- Semantic compaction rebalances earlier summaries as evidence arrives while
  preserving source identities. Its instructions prioritize unfinished
  comparisons, exact record/value associations, and explicit omitted details.
- Complete semantic checkpoints use a shared token allowance of 30% of each
  consuming model's context window, including summaries, continuation, and
  reference metadata. Provider token counts are used when available; otherwise
  the configured estimator applies. Full input still reserves response headroom
  and must fit its hard context limit.
- Execution Agent Controls, payload authors, and Auditor reviews reuse verified
  source summaries within the same request, call, and accepted objective.
  Unmatched evidence
  and independent supplements remain available; changed objectives or steering
  cannot reuse stale summaries.
- Operation-supervision notices retain their accepted action and result through
  compaction, using exact evidence or a verified summary marked as partial.
- Compacted inputs can proceed above the compaction trigger only when they fit
  the hard input budget and every eligible history and active-request source
  has a complete exhaustion proof. New reductions must also reduce input;
  discarded history cannot supply an exhaustion proof.
- Compacted tool receipts replace duplicate summaries only when they exactly
  cover the output. Summaries that differ from the output, including in
  whitespace, remain unchanged.
- Compaction output validation and provider token counting obey the model
  attempt's deadline and cancellation while asynchronous validation is pending.
- Context indicators consistently use a measured input count or a labeled
  estimate. Measurements and compaction remain tied to the correct model
  invocation across step changes, initial request events, and session replay.
- After request admission, Supervisor failures persist one bounded explanation
  while retaining the original failure cause. Cancellation, newer steering, and
  terminal delivery failures cannot create a second terminal response.
- Execution Agent and Worker guidance uses saved scripts for long programs,
  requires complete commands, and distinguishes failed parsing from zero matches
  or completed analysis. Advisory plans include script creation before execution.
- OpenAI core decisions leave room for reasoning when it is enabled or left to
  provider defaults. The short decision-output cap applies only when reasoning
  is explicitly disabled. Output-limit failures explain exhaustion and suggest
  reviewing the model and reasoning settings.
- Document-reading tools explain supported formats and direct source-code reads
  to the available file readers, including unsupported-format errors.
- Brave search retains retrieved results when an optional source-page fetch times
  out and reports incomplete coverage. Cancellation and overall deadlines still
  stop the search.
- Project inspection, code outlines, JSON inspection, local search, and disk
  probes resolve relative paths against the current request's working directory.
  Project trees, manifests, and reusable search-result paths retain that same
  directory across concurrent project requests.
- Supervisor-based SPARK initiatives author the message, title, and handoff
  background in separate raw-text stages. Source selection, objectives, and
  timing remain structured, and accepted stage progress is preserved. Raw
  authoring avoids conflicting calibration instructions and reports its text
  contract in diagnostics.
- Proactive SPARK progress remains valid for up to six days from admission
  across restarts and shared daily quota deferrals. At exhausted quota,
  completion requires successful replay of all required stages without a new
  model call. Changed or incomplete progress waits for available quota.
- Proactive suggestions are recorded once, in order, as assistant messages in
  SPARK history and follow normal context compaction. Recent human messages can
  guide the language and tone of suggestions, without changing initiative
  eligibility, learned facts, or permissions.
- Clearing SPARK messages coordinates with active requests, saved approvals, and
  proactive delivery. Transcript attachment cleanup can resume after a failure
  or restart. Environment navigation preserves drafts and queued messages until
  navigation checks have passed.
- SPARK notifications are retained and open the correct environment and
  conversation, targeting the exact retained message when available. Companion
  accepts these links for replies, suggestions, approvals, and failures, and
  rejects malformed targets.
- SPARK keeps unread state across reconnects and marks only visible messages
  as read.
- Projects, Spark, and the model catalog refresh when onboarding makes the
  Runtime ready. Older responses and setup errors cannot overwrite refreshed
  state. SPARK guides users to model settings when configuration is missing and
  disables unavailable actions.
- macOS screen capture preserves numeric geometry across native observations,
  avoiding false desktop-change failures before capture.
- Mac notification setup preserves the compiler-generated app executable and
  verifies the installed bundle before advertising notification support.
- Mac key combinations accept case-insensitive key names and the Cmd alias;
  the tool contract documents supported modifier and navigation names.

### Upgrade notes

- The scheduler journal upgrades automatically to schema version 4 while
  preserving existing Jobs and run history. ABot 1.5.0 cannot read the upgraded
  journal; back up scheduler data before upgrading if a downgrade may be needed.
- Update the installed Companion to release 10 through **Home → Computer access**
  for Studio and SPARK notification links and the Mac capture, notification,
  keyboard, and permission fixes. On macOS, check the Companion and active
  Runtime permissions separately; a grant for one route does not grant the other.
- Previously delivered SPARK suggestions remain in their historical
  conversations. Suggestions without a saved handoff brief cannot open a new
  work conversation. Clearing SPARK messages preserves the conversation's
  identity, permissions, and long-term memory.
- EXEC's former `outputMaxChars` setting no longer clips output.
  `outputRetentionMs` defaults to seven days after capture writers close;
  reading or restoring saved output does not renew this period. Retention limits
  output age and does not impose a disk-space quota.
- Older SPARK progress can reuse compatible review stages; changed JSON authoring
  stages are regenerated under the current quota. Learning and reassessment
  keep their existing 24-hour progress lifetime.
- Automation step details are retained for 30 days and reports for 90 days.
  Source snapshots remain while referenced by retained reports; unresolved
  effects delay cleanup. Reruns require their retained source snapshots.
  Ordinary Job history keeps its existing retention behavior.

### Development

- CI runs tests in parallel shards and verifies complete, non-duplicated test
  coverage before passing validation. The separate macOS Companion checks were
  expanded, and asynchronous tests wait for completion signals.
- Regression coverage includes history and active-request reduction,
  context-window changes, canonical handoffs, generated report evidence,
  subsequent recall, and unrelated follow-up requests.

## 1.5.0 - 2026-09-28

ABot 1.5.0 introduces ABot Spark, desktop observation and control, native
notifications, and a redesigned Web UI. It also expands memory management and
strengthens request cancellation, approvals, and delegated-work reliability.

### Added

- ABot Spark brings optional learning from computer activity and proactive
  conversation suggestions. Collection, learning, and proactive mode have
  independent controls and activity hours. Learning and proactive reviews select
  models and share daily usage limits; application rules separately control
  collection and processing. Collection and proactive messages are off by default.
- Desktop activity collection uses visible accessibility text from the paired
  computer, with bounded local history, application filtering, and explicit
  partial-coverage reporting. Learning and proactive reviews cannot invoke tools
  or act on suggestions themselves.
- Spark learning can start on a time interval or an eligible observation count.
  Supervisor profiles use bounded review stages with saved progress that can
  resume after pauses, resource deferrals, or restarts while its inputs remain
  valid. Execution Agent profiles use direct reviews.
- A dedicated Memory workspace manages saved records and embedding setup;
  Spark shows memory candidates. Home offers a keep-or-delete review of saved
  memories, resumes unfinished reviews, and hides completed reviews until more
  records are available.
- SYSTEM desktop tools discover desktops and windows, capture visible screens
  or regions, and click, move, drag, scroll, type text, press key chords, or focus
  an observed window. Actions bind to a fresh observation and reject detected
  focus, session, or geometry changes.
- Desktop backends cover Windows, macOS, and Linux X11/Wayland, with host access
  from WSL or Docker through supported native routes or the paired Companion.
  Available operations depend on the desktop, installed helpers, and OS grants;
  see the [SYSTEM platform requirements](plugins/system/README.md).
- Tool images travel as temporary request-bound media to supported model
  consumers. Screenshots are excluded from persisted conversation history and
  ordinary provider traces, and released when the request ends or is cancelled.
  Models without image support receive an explicit limitation.
- A persistent Notifications inbox provides unread filtering, read controls,
  and source links for replies received outside the focused conversation,
  failures, pending approvals, and Spark suggestions.
- Native desktop alerts use the paired Companion on Windows, macOS, and Linux,
  with settings for each notification kind and visible delivery status.
  Delivery can work with the browser closed while Runtime and Companion run;
  operating-system notification permissions and platform requirements apply.
- Conversation organization adds a pinned section, drag-and-drop and keyboard
  reordering, and archive/restore controls. These preferences are local to the
  browser and environment; archived conversations are also hidden from Home.
- Direct workspace URLs and browser Back/Forward restore the selected
  environment, conversation, configuration section, or Job.
- A persistent composer Stop control cancels the active request, closes owned
  resources, and preserves the stopped exchange for later conversation context.
  Completed tool effects are not rolled back.
- Spark's initial proactive conversation offers **Keep** and **Not interested**
  before the user replies. Keep records a browser-local choice; Not interested
  archives the conversation and returns Home.
- Project groups initially show five conversations with **Show more / Show less**.
  Search reveals every match, and pinned and ordinary conversations remain uncapped.
- Web UI approval waits are saved with their conversation and survive Runtime
  restart. An explicit decision resumes the exact prepared action when its saved
  continuation is compatible. New messages and Jobs in that conversation wait
  until the request resumes or is cancelled.
- The optional `@abot-ai/runtime/plugin-sdk/computer-access` entry point lets
  compatible plugins reuse Runtime-owned computer backends and the paired
  Companion connection.

### Changed

- The Web UI uses an ink-and-mint design with labeled navigation, clearer
  configuration forms, collapsible project groups, and a Home composer anchored
  below the dashboard.
- Agent activity appears inline in conversations, with an optional timeline and
  compact, expandable reasoning. Home brings unread suggestions, pending
  approvals, recent conversations, and Companion updates into view.
- Computer access uses one setup and pairing shared by SYSTEM, Spark, and
  compatible plugins. Linux setup is available, and Windows/WSL setup no longer
  requires changing interop settings or restarting the distribution.
- Automatic memory proposals from conversations and Spark share one candidate
  pool and admission policy. A new candidate requires at least two independent
  evidence opportunities and a configurable promotion score before recall.
  Replayed observations and unchanged revisits do not count as new support.
- Explicit requests to remember a fact can use protected core-memory saves
  bound to the current user message. Manual records, edits, and deletions take
  precedence over automatic replacements. The standalone memory plugin retains
  its separate store and does not require the core memory service.
- Jobs support saved Full or FULL+ permissions. New Jobs default to Full, and
  existing Jobs retain their permission mode unless explicitly changed.
- Newly added model profiles use separate configuration files. Removing a model
  declaration preserves its file and credentials; existing inline profiles
  remain supported.
- Worker and Planner handoffs retain full result prose without fixed character
  ceilings, subject to configured context admission and compaction.
- Home and Jobs refresh from committed server events while preserving current
  selection, expanded sections, focus, and scroll position.

### Fixed

- Fresh Web UI onboarding keeps unavailable pages disabled and hides Spark until
  setup is ready, while independent Computer access remains available. Spark
  Settings also exposes the existing save action beside Activity permissions.
- Spark activity authorization is separate from its start/stop controls. Home starts
  the authorized activities together; stopping preserves the saved selection,
  and granting permission requires a configured model without starting work.
- Computer access stays at the top of Home with connection status and pairing
  controls. Models and Plugins have their own navigation pages, and Config is
  renamed System while preserving existing links and unsaved-change protection.
- Native macOS Computer access connects or repairs through the installed ABot
  runtime, preserves pairing, and uses a stable private Node executable across
  sign-ins. Companion startup handles macOS temporary-directory and broker
  socket path limits.
- Companion loopback connections support IPv4 and IPv6 while preserving the
  Runtime hostname for TLS certificate validation.
- On macOS, Home and Spark offer **Restart collection** after an Accessibility
  permission block. The action rechecks access without restarting the Runtime,
  changing collection settings, interrupting reviews, or deleting pending work.
  Permission guidance identifies the Companion executable and checks for consent
  for up to two minutes before offering another attempt.
- System status and trace paths follow the selected environment and ignore stale
  responses after switching. Notifications use readable cards, Schedules opens
  with the Active filter, and plugin states have distinct color indicators.
- Invalid, truncated, or timed-out delegated model output returns a failure to
  the correct parent without granting completion or review approval. Recognized
  root-output failures can return confirmed progress and remaining limitations,
  while cancellation, request deadlines, and newer steering retain priority.
- Exact audit evidence uses the model's physical context budget instead of
  failing solely because it crosses the ordinary compaction trigger.
- Saved Web approvals retain their remaining execution budgets and release live
  request resources while waiting. Compatible waits can resume after restart or
  Computer reconnection without repeating model decisions or payload preparation.
  Bridge and scheduler clients retain their existing live-owner approval lifecycle;
  elapsed time or connection loss does not become a user rejection.
- Waiting, resumed, and final output remain in one conversation response with a
  continuous activity timeline. Saved approval prompts are excluded from later
  model history, preserving the preceding final answer and settled artifact paths.
- Duplicate or stale approval decisions cannot dispatch a different activation.
  Cancellation remains distinct from rejection, and unavailable or incompatible
  continuations remain visible and cancellable.
- Tool outcomes and unavailable source content use neutral presentation with
  expandable error details. Spark activity markers reflect Collection, Learning,
  and Proactive state and stop active animation when connection state is stale.
- Stopping a request preserves already streamed response text and accepted
  steering in durable conversation history. Cancellation and graceful shutdown
  handle late model results and concurrent request lifecycle transitions.
- Memory admission, explicit supersession, and policy changes apply atomically.
  Saved records remain protected from stale replacement candidates, duplicate
  evidence, and concurrent manual changes.
- Spark preserves eligible pending work across transient failures, processing
  pauses, budget exhaustion, and restart. Completed review stages and committed
  receipts prevent repeating accepted work; expired or changed inputs invalidate
  saved progress.
- Spark collection reduces repeated reads on noisy screens, avoids duplicate
  embeddings, and excludes ABot's own identifiable windows. Collection and
  processing exclusions remain independent, with visible coverage limitations.
- Companion observations redact entire fields containing recognized credential
  labels or secret formats before transport, including captured text and source
  metadata. Recognition is bounded and applies only to new observations.
- Notification history reconciles atomically, avoids duplicate records, and
  retains delivery failures. Unconfirmed alerts are not resent after reconnect
  or restart. Windows setup repairs notification registration and removes owned
  legacy registrations.
- Companion updates replace the running bundle while preserving pairing.
  Source Web UI startup builds the Companion before starting the service.
- Model configuration writes preserve referenced paths and pinned snapshots,
  reject unsafe file entries, coordinate removal with pending saves, and avoid
  duplicate profiles when activation is deferred.
- Web UI navigation rejects stale session loads and replayed activity, preserves
  read-only dashboard access during configuration recovery, and reports memory
  availability and review errors.
- Document-reader windows distinguish omitted leading content from remaining
  trailing content, so reaching the end of a document does not claim that the
  complete document was returned.

### Upgrade notes

- Approval events from older versions cannot become executable saved continuations.
  Restart interrupts work that was running and never automatically replays it;
  compatible saved approval waits remain pending. If an action was already running
  when interrupted, inspect its effects before trying again.
- Update an installed Companion through **Home → Computer access** for the
  current desktop, notification, and observation-redaction features. Updating
  Runtime alone does not replace an already running native Companion.
- Core memory storage upgrades automatically to schema version 5, preserves
  existing records, and creates a private `.pre-v5.backup`. ABot 1.4.0 cannot
  read the upgraded store; preserve the backup if a downgrade may be needed.
  The independent memory plugin's storage is unchanged.
- Desktop control still requires native acceptance checks for the actual OS,
  permissions, applications, and model provider. Automated transport and helper
  tests do not establish interactive support on every desktop; current coverage
  and platform limits are documented in the SYSTEM plugin.

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
