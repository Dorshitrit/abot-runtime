# Plugins

Every runtime capability is installed as a self-contained package beneath a
`plugins/` directory. Runtime orchestration discovers these packages; it does
not declare concrete tools or skill text itself.

An installed `@abot-ai/runtime` package contributes its bundled public plugins.
The configured consumer root may contribute additional packages beneath
`<consumer-root>/plugins`; the loader merges both catalogs in stable order. A
duplicate manifest `name` across the bundled and consumer catalogs is rejected
rather than treated as an override. In a source checkout, where both roots are
the same physical directory, the catalog is discovered only once.

## Manage Plugins In The Web UI

Open **Plugins** to see installed manifests, capability counts,
and enabled, partially enabled or disabled selections. Switches save the selected
plugin's configuration while preserving capability-specific allow/deny rules.
Whole-plugin switches use `plugins.disabledPluginIds`, an exact list of plugin
IDs independent of capability names and qualified selectors. The list does not
interpret wildcards; legacy `allow` and `deny` rules keep their existing meaning.
Choose **Manage tools** on a plugin to manage its declared tools inside the same card.
The card keeps its size; the tool list scrolls when needed. Use **Back** or Escape
to return to the plugin overview. For example, disabling filesystem.read_file
leaves dev_view, edit_file and write_file unchanged. Tool switches write qualified selectors and preserve
the selections of every other tool. A plugin can remain enabled with all its
tools switched off.

Global, parent-plugin and broad tool deny rules remain explicit blockers.
A child switch does not silently remove those rules or enable sibling tools.

Install, configuration saves, enable/disable and Remove require every owning Runtime to be idle.
While a conversation or Job is running, these actions return a clear message
without saving the requested change. Open but idle conversations do not block
changes; browsing and reviewing repositories remain available. If another process
owns an environment, use the owning Web UI so its activity can be verified.

Choose **Apply changes** to activate saved settings. The Web process replaces
only its own idle environments and preserves session and Job files. If any
environment is working, or another process owns it, changes remain saved and
the UI explains why they cannot yet be applied. Saving a switch alone does not
change tools available to an already running agent.

## Configure Plugin Values

Choose **Configure** on an installed plugin, or use the same form during its
installation review. Fields come from the existing `settings.defaults` and
`secrets` declarations. Strings, numbers and booleans use ordinary controls;
objects, arrays and null defaults use JSON. The host checks declared setting
names and top-level default types. A null default supplies no type information;
semantic checks such as URL validity remain the plugin's responsibility.
The form shows whether each setting uses the plugin default or a local value.
Saving credentials alone leaves inherited defaults unchanged. Editing a setting
creates a local override, even when its value equals today's default; **Use plugin
default** removes that override when saved. Existing saved values stay local until
explicitly reset, so no upgrade automatically rewrites a user's configuration.
No manifest schema or SDK changes are required. If an upgraded plugin changes a
setting's default type, an incompatible retained value blocks loading with an
explicit configuration error. Configure remains available to correct the value;
the host does not silently replace it with a default.

**Save changes** persists values locally; **Apply changes** loads them into new
idle Runtime owners. Existing owners retain their loaded values, including when
activation fails and restores the previous configuration. GET returns settings
and credential-presence flags, never secret values. Passwords remain in their
mounted controls until submitted, and are cleared after submission.

Values are shared across environments of the same consumer root and are stored
in `<consumer-root>/.runtime/plugin-configuration.json`, outside plugin packages,
with owner-only file permissions. On POSIX, an existing file with any group or
other-user permission is rejected before its contents are read. Restore its
permissions with `chmod 600 .runtime/plugin-configuration.json` from the installation
root; the host does not change permissions automatically. They are local plaintext
configuration, not an
encrypted vault. This file must not be committed, published, or shared with a
plugin repository. The existing `.runtime/` exclusion also keeps it out of Git
and packages. Settings override declared defaults; undeclared settings are not
passed to plugins. A locally configured secret is bound to its declared name
and environment-variable name and is delivered through `context.secrets.get`.
Without a local override, the existing process environment remains the source.
Saving plugin values does not write `.env` or change `process.env`. Browser revision
tokens use a private process key rather than an unkeyed digest of secret-bearing
content. Reload an open form after restarting its Web UI process.

Keys removed from the current manifest, or whose environment binding changed,
appear under **Keys no longer used by this plugin** without exposing their values.
They remain saved until the user selects **Delete saved key** and saves. Ordinary
settings edits do not delete them. A changed binding under the same key name
requires explicitly deleting the old saved key before setting or clearing its
replacement; both choices can be submitted in one save. Configure remains
available for these keys even when the plugin has no current settings or secrets.

For each secret, keep the current value, replace it, or explicitly clear it.
Clear suppresses an inherited value for this plugin without deleting a shared
environment variable. Clearing a required secret prevents the plugin from
loading on the next Apply until the key is configured again. Remove retains
local settings and secrets; a later installation review shows the retained
settings and presence flags. Required secrets are checked before installation
commits, and failed selection saves roll back the local configuration and package.

## Install Community Plugins

The **Installed** tab manages the existing catalog. **Discover** links to the
[ABot Marketplace](https://abot-ai.com/marketplace/) and installs public GitHub packages independently of that directory.
The Marketplace is a directory of community-owned repositories; listing approval
does not grant a repository permission to run on a user's machine.

Paste a repository URL in **Discover**, optionally choosing a branch, tag or
commit and a folder inside the repository. **Review plugin** resolves the source
to an exact commit, validates the manifest and its declared files without
executing plugin code, and displays its tools and configuration form.
Fill in required secrets before confirming installation.
**Install and enable** downloads the same commit, checks the reviewed content
digest, and installs it at `<consumer-root>/plugins/<manifest.name>`. Existing
plugin IDs and capability IDs are rejected; this flow never replaces a plugin.
Package publication and selection saving share the configuration lock with Apply;
a failed save removes the uncommitted package before Apply can discover it.
The normal configuration controls and global restrictions still apply.
The review offers **Install and enable** at both ends. After installation, the
UI returns to **Installed** with a status message. Choose **Apply changes** to
load the plugin into the Runtime.

Publishers must commit a complete package: `plugin.json`, its built CommonJS
`.cjs` entrypoint, referenced skills and all required assets. Bundle dependencies
that are not supplied by the public plugin SDK. Installation does not execute
`npm install`, build commands, lifecycle scripts or repository code. Public HTTPS
repositories on `github.com` are supported; private repositories, updates and
Studio packages are outside this first installation flow. Repository ZIPs are
limited to 25 MiB and 2,000 entries, with at most 16 MiB per extracted file and
64 MiB total. Symlinks, traversal and non-portable filenames are rejected.

### Install In ABot Links

Computer Access setup registers the `abot:` URL scheme on Windows, macOS and
Linux desktops. Existing installations can use **Update** in Computer Access
to install Companion release 12 and register links while keeping their pairing.
A website can render an ordinary link using this contract:

```js
const link = new URL("abot://install");
link.searchParams.set("kind", "plugin");
link.searchParams.set("repo", "https://github.com/owner/plugin");
link.searchParams.set("ref", "v1.0.0"); // optional; a commit is recommended
link.searchParams.set("path", "plugins/example"); // optional repository folder
installAnchor.href = link.toString();
```

Clicking the link opens **Discover** in the Runtime saved in the local Computer
Access pairing, with the source ready for review. A link cannot choose another
Runtime address or bypass local installation confirmation. The browser may ask
to open ABot. Without Computer Access, users can paste the same repository URL.
Companion disconnect/uninstall removes its owned protocol registration.

The local API uses `POST /runtime/plugins/inspect` with
`{ repository, ref?, path? }`, returning `{ ok, review }`.
Installation uses `POST /runtime/plugins/install` with
`{ source: review.source, digest: review.digest }`. Both require same-origin
JSON requests and completed Runtime setup. These APIs operate on the configured
consumer root and configuration file; they do not depend on the Marketplace.

## Remove Community Plugins

**Remove** is available in the ongoing Plugins screen for packages installed by
this GitHub flow. After confirmation, it saves a disable, applies configuration
through the existing idle-owner checks, and only then deletes the installed
folder. Built-in plugins and manually copied folders without an installation
receipt do not offer Remove. Removal adds only the target's exact ID to
`plugins.disabledPluginIds`, so names shared with other tools or qualified
selectors cannot change another plugin's selection.

If work starts after the disable was saved but before Apply, the files remain.
Finish the active work, then choose **Remove** again. A failed Apply or any
concurrent configuration change also prevents deletion. Removal verifies the
moved directory before deleting it and retires its cached CommonJS modules so
a later installation loads the new entrypoint and package-local dependencies.
Selection rules remain in the configuration so removal cannot widen another
plugin's allow policy. Installing the same plugin again clears its exact disabled
ID and preserves other disabled IDs and capability-specific deny rules. Existing
qualified denies are not inferred to be removal-generated; review such legacy
rules explicitly in Advanced settings if they still disable the tools.

`POST /runtime/plugins/remove` accepts `{ pluginId }`, with the same origin,
JSON and completed-setup requirements as installation. It returns `removed`,
`activation`, a status message and the refreshed plugin snapshot. This removes
the installed plugin folder, including data the plugin kept inside it; files
stored elsewhere are retained. If Apply succeeds but a later removal check fails,
the error retains its HTTP status and code and includes `activation` with status
`ready`. The UI refreshes the active environments; `config_changed` still marks
the newer saved configuration as pending activation.

## Package Shape

```text
plugins/
  plugin-name/
    plugin.json
    source/
      index.ts
      ...                         # owner-focused TypeScript modules
    src/
      index.cjs                   # generated CommonJS entrypoint
    skills/
      skill-name/
        SKILL.md
    README.md                 # optional
```

`plugin.json` is the single declaration source. It identifies the package,
points to its implementation, declares capabilities and their operations, and
binds skill files once to each capability that needs them. `source/` is the
canonical, type-checked implementation. `src/index.cjs` is deterministic build
output and must not be edited by hand. A plugin may omit `skills/` when it has
no model guidance.

## Runtime Configuration

The root runtime config only enables or filters installed packages:

```json
{
  "plugins": {
    "enabled": true,
    "allow": ["*"],
    "deny": ["filesystem.read_file"]
  }
}
```

- `enabled: false` disables the installed catalog.
- `allow` accepts `*`, a plugin name, a capability name, or
  `plugin-name.capability-name`. An omitted or empty list also allows the
  installed catalog.
- `deny` accepts the same selectors and is applied after `allow`.

There are no plugin paths, factories, tool declarations, implementation
options, or skill lists in `runtime.config.json`. Installing or changing a
plugin means changing its package under `plugins/`; runtime config only decides
whether that installed capability is available.

## Runtime Platform Compatibility

A plugin can declare where its code can run using a separate manifest extension:
`extensions["ai.abot.compatibility"] = { "version": 1, "runtimePlatforms": ["linux", "darwin"] }`.
The executable `ai.abot.runtime` extension remains at version 1.

`runtimePlatforms` is a non-empty, duplicate-free list of Node platform names:
`linux`, `darwin` (macOS), or `win32` (Windows). Unsupported versions, platform
names and fields are rejected. Declare only platforms on which the complete
plugin can safely load; individual operations may still require permissions,
external programs or a connected computer.

The declaration describes the **Runtime host**, not the browser or the computer
controlled by a tool. A Linux Runtime in WSL or a Linux Docker container remains
`linux`, including when SYSTEM controls a Windows Companion. It does not grant
permissions or replace the tool's request-time target checks.

Hosts with this compatibility support apply the following policy before resolving
plugin settings/secrets or importing executable plugin code:

- A declared matching platform can load, subject to the existing saved selection.
- A declared non-matching platform cannot load.
- Without a declaration, existing non-Windows behavior is preserved. Native
  Windows reports **Compatibility not declared** and does not load the plugin.

Installed, onboarding and model-selection views show compatibility separately
from saved plugin/tool selection. Changing hosts does not rewrite saved selection
or erase settings and keys. An incompatible package remains inspectable,
configurable and removable. It can be installed for later use on a supported
host; the review and installation result explain that it will not load here.
Applying configuration cannot bypass the loader gate.

**Older hosts:** ABot 1.7.0 accepts and preserves additional extension namespaces
but does not enforce this declaration. Its existing behavior remains unchanged.
This metadata is not an enforcement guarantee on older hosts, nor a claim that
ABot 1.7.0 or its bundled plugins support native Windows. Existing bundled plugin
manifests are not certified for Windows by this contract change.

The required `windows-compatibility` CI job builds the Runtime, checks types and
plugin packages, and runs the focused platform contract and loader suites on
Windows with Node 24. It complements the Linux validation and macOS Companion
checks; it does not certify all native Windows tool operations or Store packaging.

## Manifest Contract

`@abot-ai/runtime/plugin-sdk` is the single public plugin-authoring entrypoint. It
exports the manifest constants and types, entrypoint contract, and bounded
authoring helpers consumed by plugin implementations.

The SDK's `readBoundedRegularFile(path, { rootPath, maxBytes, signal })` reads one
regular file within its authorized root and returns bounded bytes or a typed
refusal. On native Windows, it uses the same C# handle primitives as `filesystem`,
compiled by the built-in Windows PowerShell for each read. Root and file identity
are checked before reading; traversal rejects reparse points beneath the root,
including junctions. Binary content and documents up to 10 MiB are covered by
native tests; each caller still sets its own size limit. Linux/macOS retain the
existing no-follow file-descriptor path.

A Windows policy or compiler restriction returns `safe_open_unsupported`. Plugins
must report that safe reading is unavailable and avoid automatic retries or a
less restricted fallback. Cancellation stops the helper and throws `AbortError`;
a helper deadline (15 seconds) or ordinary I/O failure remains an explicit error.
This SDK support does not enable Windows compatibility in a plugin manifest.
Each plugin must still declare and validate its own Windows support.

The manifest follows the Agent Plugins 1.0 package shape and keeps the local
executable contract under `extensions.ai.abot.runtime`:

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  "name": "example-lookup",
  "version": "0.1.0",
  "description": "Read bounded example data.",
  "extensions": {
    "ai.abot.runtime": {
      "version": 1,
      "entrypoint": "./src/index.cjs",
      "catalogGroups": ["read"],
      "capabilities": {
        "example_lookup": {
          "description": "Read bounded example data.",
          "routingCapability": "semantic_lookup",
          "skills": ["example_lookup_skill"],
          "operations": {
            "lookup": {
              "summary": "Look up one bounded value.",
              "input": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                  "query": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 1024
                  }
                },
                "required": ["query"]
              },
              "effect": "read_only",
              "approval": "request_policy"
            }
          }
        }
      }
    }
  }
}
```

Each capability becomes one runtime-visible capability descriptor and must have
a handler with the same id. The frozen execution policy determines whether the
canonical Worker or root may bind it; the plugin does not select that
principal. A capability owns its skill bindings, and each operation owns its
input, effect, and approval. Optional capability metadata such as client event
presentation, payload authoring, development roles, and selection grounding
belongs here as well—not in runtime orchestration.

An operation may declare `outputChannels` alongside `summary`, for example
`{"text":"content","data":"metadata"}`. Both fields are required when declared:
`content` can carry substantive output (possibly bounded or summarized),
`metadata` contains only identifiers/status/counts/receipts, and `conditional`
depends on the operation inputs. Omission means unknown, not metadata. This
passive declaration describes the saved Studio channels, not every field in a
chat tool result; it changes no execution or binding behavior. Only selected
Studio `prepare_draft` operations expose it to models; ordinary tool summaries
and discovery stay concise. Whole Data bindings do not need field pointers.

A plugin declares sensitive operations with `approval: "always"` in its
manifest, as the bundled EXEC and SYSTEM plugins do. Apply that policy to every
operation when the whole plugin is sensitive. The generic approval boundary
keeps enabled operations available in all modes: Ask and Full approve each exact
prepared action; FULL+ skips that extra prompt. A disabled plugin stays absent.
Sensitivity is declared by the plugin, never inferred from command text or tool
names. Ordinary `request_policy` operations retain their existing mode behavior.

`catalogGroups` classifies a capability in one or more request-catalog groups.
A plugin-level non-empty array under `ai.abot.runtime` is inherited by every
capability; an optional capability-level array overrides that default. Values
must be unique bounded lowercase ids matching
`[a-z0-9][a-z0-9._-]*`; `read`, `write`, `web`, `memory`, and `other` are current
built-in conventions, not a closed enum. Manifests that omit both levels remain
compatible and use the plugin name as their single catalog group.

The delegated Supervisor and Planner select group ids when invoking a Worker
against a non-empty catalog. The runtime stores that scope on the Worker call
and exposes the OR-union of matching capabilities. The Worker still selects
the concrete capability and controls.

Supervisor routing and delegated Planner each receive one optional, passive
brief from the request-filtered registry. They share EA's plain-text discovery
catalog, organized by selectable group id with ` | ` between group entries:

```text
Tool groups: scheduling: schedules | write: filesystem [edit_file, write_file]
Plugin descriptions: filesystem: Inspect, read, write, and edit files within configured agent-work and workspace roots.
```

Each group lists its plugins and their tool names as `group: plugin [tool names]`.
Native tools appear by name without a plugin wrapper; groups without tool entries
remain bare ids. A plugin may span groups, and a group may contain several plugins.
Reserved characters in tool names are percent-encoded. Each optional plugin
description appears once on the separate `Plugin descriptions:` line, with
whitespace normalized, `|` displayed as `/`, and at most 160 Unicode code points
plus `....` when truncated. Missing descriptions leave the tool bindings intact;
the description line is omitted when none are available. This index lists tool
names, not individual operations, summaries or parameter schemas. Worker still
receives the exact operations and controls from the selected groups.

Admission preserves the existing context, configured instructions, calibration,
output and safety reserves and compaction threshold. Root steering is reserved
only for Supervisor; it does not enter the bounded Planner call. When the whole
plugin catalog cannot fit, complete group counts and effects remain available
under the existing 512-token ceiling, or the optional brief is omitted. Legal
group ids remain in the response schema. Neither fallback restores operation
details, selects a partial set of plugins, or adds a model decision. The brief
carries no execution authority or completion evidence. EA's output and the
Worker, approval and terminal-response contracts remain unchanged.
Before each Supervisor routing or Planner attempt, including structured-output repairs,
the optional brief is reselected against the actual projected messages plus
current consumer-specific calibration and context. It retains its reference position or is
omitted when no complete level fits; repair instructions and other context stay
intact. Already inserted methodology is counted once. Provider token counts may
still differ from these estimates and trigger the existing context-compaction
path.

The SDK exports `buildToolAvailabilityBrief` for the unchanged on-demand plugin
output and `buildToolAvailabilityOverview` for informational representations.
The runtime context helper owns token admission and the passive reference
message; another step can explicitly attach it using the existing context
reference API. Supervisor's working-directory and response phases do not
receive it. Planner uses this same brief instead of a separate aggregate-tag
catalog. Its existing group-selection schema and Worker scope enforcement stay
unchanged; descriptions do not select a group or execute an operation.

Under `execution-agent-v1`, the canonical root receives the same plain-text
discovery catalog shown above. Descriptions supply discovery context, not
instructions or authority. The root may mechanically open or extend
its RoleCall scope. Only then does the active catalog expose each capability's
id, exact summary, and effect, with selection controls in the decision schema.
It selects concrete capabilities only from that active scope. Scope updates,
binding, payload authoring, execution, and settlement retain the shared engine
and ledger. Unknown, empty, invalid, repeated, or no-op scopes are rejected. Requests
without Worker capabilities may still invoke an unscoped knowledge-only Worker.

Skill ids resolve only inside the same plugin package. For the example above,
the loader reads:

```text
plugins/example-lookup/skills/example_lookup_skill/SKILL.md
```

No skill is globally or always included. Guidance is projected only for the
selected capability from its capability binding, whether the authorized
principal is Worker or the direct root.

`controlsRefinement: "mechanical_when_complete"` is an explicit
capability-level optimization for a single invocation whose selection-owned
controls already cover every declared public control. Such a capability must
declare an empty `skills` list, so no execution-only guidance or semantic veto
is bypassed. The runtime still uses the ordinary controls decision whenever an
optional or required control remains, and batching retains its ordinary
refinement step. Adapter, payload, approval, execution, and result lifecycles
are unchanged.

Payload `contextScope` is enforced at the shared model-projection boundary.
The same `tool_payload.raw` author validates either the delegated Worker or the
policy-authorized canonical root. `standard` keeps the settled evidence
supplied to the payload assignment. `target_only` projects the immutable
assignment and current target without replaying prior settled results or
related-artifact bodies. `target_with_artifacts` also projects ordered settled
receipts and the selected current related artifacts; external evidence remains
inline unless its complete content is proven identical to an already projected
target or artifact body, in which case the receipt points to that body's
`contentRef` instead of duplicating it.

## Entrypoint Contract

`source/index.ts` exports one factory. The factory receives immutable package
and runtime services, then returns handlers keyed by capability id and any
matching call adapters. Public plugins use the shared Plugin SDK for parameter,
path, result, error, and bound contracts while keeping plugin-specific policy
inside their own package:

```ts
import {
  defineRuntimePlugin,
  readRequiredString,
  successResult,
} from "@abot-ai/runtime/plugin-sdk";

export default defineRuntimePlugin(() => {
  return {
    handlers: {
      async example_lookup(params) {
        const query = readRequiredString(params.query, {
          name: "query",
          maxLength: 1024,
        });
        return successResult({
          output: `Found one bounded result for ${query}.`,
          data: { hasData: true, itemCount: 1 },
        });
      },
    },
  };
});
```

Run `npm run typecheck:plugins` while developing. Run
`npm run build:plugins` to regenerate every public `src/index.cjs`; CI uses
`npm run check:plugin-build` to reject stale or hand-edited generated output.

Plugins may export an asynchronous `prepareRequest(selectedModules)` hook alongside
`handlers` and `adapters`. The host invokes it once per plugin for each request,
after configuration selection and before projecting any model catalog. It receives
detached frozen contracts and may remove tools or operations, narrow input enums,
update operation summaries, and bind request-local implementations/adapters.
Names, definitions, effects, approval policy, fixed parameters, and the remaining
input contract cannot change. Disabled tools are never passed to the hook and
cannot be returned. A preparation failure fails the request; it does not silently
restore the unprepared catalog. Prepared state is not cached across requests.

A call adapter may provide `executionBinding(call)` with an opaque `identity` and
optional human-facing `metadata`. The identity participates in the normalized
action fingerprint before approval; it is not a model input or tool result.
Metadata is for approval and Activity disclosure only. The bound implementation
must enforce that same captured destination at dispatch and reject stale bindings.
Both supported execution policies consume this same prepared registry.

The loader rejects missing or unexpected handlers. Plugin settings defaults
and secret environment-variable names may be declared in `plugin.json`;
secret values never belong in the manifest. Optional secrets do not alter the
declared capability catalog; a handler that cannot operate without one must
return a clear plugin-owned configuration error.

Every handler must return one plain JSON-safe result object. Set `ok`
explicitly, provide the required string `output` and boolean
`producedNewInformation`, and place structured operation facts needed by later
steps in `data`. JSON-safe here means primitives, plain objects, and dense
arrays with finite numbers: no functions, symbols, accessors, cycles, class
instances, or other non-plain prototypes. Results use a 256 KiB serialized
envelope boundary. A context-aware host exposes `context.resultBudget`; pass it
to `deliverPluginTextResult(result, ["stdout", "stderr"], context.resultBudget)`
to hand exact large text to the existing context manager. The helper keeps
ordinary results unchanged. When needed, it declares `contextTextFields` on
the original result; metadata and references still count toward the byte limit.
Only `output`, `stdout`, and `stderr` are eligible string fields. The Runtime
retains their full content and applies token admission and compaction before
model invocation. This does not manage the plugin's output storage or RAM.
Hosts without this contract and plugins that do not opt in retain their
existing result limit. Neither plugin nor Runtime may silently remove facts.

`ToolRegistry` adds the selected tool identity and creates the canonical
`ToolExecutionResult`. The Runtime validates and persists that complete result,
then projects it only to the exact root or Worker call that produced it and to
later payload authoring in that same call. A conforming new plugin therefore
works across direct and delegated execution without capability-specific
projection code under `src/runtime`. Result contents are model-facing evidence:
they must not include secrets and they never act as instructions, new user
intent, or proof that the whole request completed. See
[tool-execution-result-evidence-contract.md](tool-execution-result-evidence-contract.md).

### Reporting a confirmed mutation

Use `successResult()` for ordinary successful observations. After the owning
plugin has confirmed a completed mutation, use `mutationSuccessResult()` to
preserve its receipt and add the Runtime's required `data.mutationEvidence: true`:

```ts
import { mutationSuccessResult } from "@abot-ai/runtime/plugin-sdk";

// apiReceipt is the result of a completed write already confirmed by this handler.
return mutationSuccessResult({
  output: "The article was published.",
  data: apiReceipt,
}, context.resultBudget);
```

The helper does not execute the operation or independently verify its effect.
Do not use it for a failed, ambiguous, pending, or no-op operation. It retains
the same JSON and result-size bounds as `successResult()`; a rejected receipt
returns a failure without asserting mutation evidence. The existing generic
helper does not infer a mutation from `ok`, `progress`, prose, or the presence of
arbitrary data. Explicit `actions`, `progress`, and other result fields remain
available to the owning plugin.

The adapter records operation outcome separately from observed effect.
For a `mutating` operation, `ok: true` without `mutationEvidence: true` is
classified as `mutation_evidence_missing`. The new helper supplies that marker
after the plugin has established the evidence; it does not change the Runtime's
classification rules or prove completion of the user's whole request.

### EXEC output storage

EXEC captures stdout and stderr in private files under its injected `stateDir`.
Pipe backpressure bounds queued capture data; the plugin does not accumulate a
process's entire output in RAM while it runs. Disk writes use 64 KiB chunks, an
I/O buffer size independent of the model context budget. A storage failure stops
the producer and returns its process ID, status, cursor and committed byte
counts; it never claims that incomplete output was successfully delivered.

Delivery materializes the pending observation into the existing text-result
contract. This still requires memory proportional to that observation; this
contract is not streaming ingestion by the Runtime. The core owns token
admission and compaction. It does not read EXEC file paths or manage its storage.

Offsets advance only after the result fits the host's delivery contract. ASK
state stores plugin-owned, session-bound disk receipts with range hashes, rather
than copying the full text. Previously saved inline receipts remain readable.
`outputRetentionMs` defaults to 604,800,000 (seven days) from capture closure,
including unaccepted output and receipts saved for approval continuation. Reading,
restoring or accepting a receipt does not extend retention. Active writers and
readers prevent deletion until they finish. Interrupted and legacy captures
without a closure timestamp expire using their last captured-file modification.

The plugin sweeps existing storage when loaded and periodically while files
remain (at most one hour between sweeps). A stopped runtime resumes cleanup when
the plugin loads again. Expired output returns an explicit tool failure with the
process ID; it never replays a command. Retention bounds age, not total disk usage.
Preparation does not create storage directories, and cleanup belongs to EXEC.

Concurrent terminal observations reserve one delivery before leaving the process
transition. Rejected presentation releases the reservation without consuming any
output. The same rule applies to restored terminal receipts.

## Filesystem Roots

`environment.paths.agentWorkDir` is the configured primary work root. Plugins
with scoped filesystem operations must resolve user-controlled targets through the injected
`runtimePathResolver`; they must not reproduce normalization, containment, or
symlink policy. The plugin explicitly declares the configured locations that
its operation accepts, while the Runtime proves the resulting physical path:

```js
async function readProjectFile(params, executionContext) {
  const target = executionContext.runtimePathResolver.resolve(params.path, {
    requirePath: true,
    allowedLocations: ["agent_work", "workspace"],
  });
  // Read only target.absolutePath; expose target.logicalPath to the model.
}
```

`.` and ordinary relative paths resolve beneath `agent_work`. The explicit
`workspace/...` namespace is available only when both the host configured that
root and the plugin declared `workspace`. A plugin may declare `runtime_root`
only for an operation whose public contract genuinely requires repository
files. Read-only system inspection may opt into `host_system`; that location
accepts absolute paths only and is never included implicitly. Plugins must not
use it for mutation or as a fallback when a configured work root is missing.
Paths outside declared roots and canonical symlink escapes fail before plugin
I/O for these scoped operations. Plugins must not infer or advertise a physical
`sandbox/` alias. Trusted shell execution follows the explicit exception below.
Attachment handles are a separate request-owned source and are not converted
into ordinary filesystem targets.

After a committed file mutation, the optional
`executionContext.reportFileOutput({ target, operation, rootIdentity })` callback
can report the exact resolved target for client presentation. `operation` is
`created` or `updated`; no-op and failed mutations must not report an output.
`rootIdentity` contains decimal strings for `device`, `inode` and `birthtimeNs`,
read from the actual mutation root directory handle. Keep that handle open until
the synchronous callback returns. The host checks this identity against the
currently configured root before reading or creating a marker. Missing or
mismatched identities omit the card, including a root replaced between commit
and reporting. A receipt is published only on a successful mutating completion
with `mutationEvidence: true`. The callback
is best-effort: its absence or failure must not change a committed mutation's
result. Never copy the receipt, physical path or presentation metadata into the
canonical tool result. The bundled filesystem write/edit tools use this channel;
it creates neither a file catalog nor a historical snapshot.

The host binds that receipt to the root directory instance using its filesystem
identity and a random token in `.abot-file-output-root`. Presentation capture
creates this small marker once, without overwriting an existing file; preview
only reads it. Symlink, malformed, missing or changed markers cannot authorize
older receipts. Removing a marker revokes those receipts; a later successful
mutation can establish a new token. Filesystems without stable directory birth
identity omit presentation receipts while preserving the tool's mutation result.
Legacy receipts containing only a path-derived root hash are not upgraded.

Plugin state belongs to the factory instance. Mutable module globals are not
allowed because one host process may load more than one Runtime. File-backed
state uses a plugin-owned directory, serialized mutations, atomic replacement,
validated persisted shapes, and explicit capacity limits.

Filesystem mutation uses an atomically installed, synced sibling file. Creating
a previously absent target is no-clobber: a competing creator wins and the
plugin reports a conflict without overwriting it. Replacing an existing target
uses optimistic version verification immediately before the atomic rename and
serializes every cooperating plugin instance in the host process. Portable
Node filesystem APIs do not provide inode compare-and-swap, so a completely
independent writer that ignores this coordination can still race in the final
existing-file commit window. Consumers that require stronger multi-process
coordination must place the work root behind a versioned or transactional store.
Mutation path traversal requires no-follow directory handles. On Linux the
plugin anchors operations through procfs. On macOS an isolated Node child
inherits the held directory handle, verifies its current directory against
that handle, and performs basename-relative operations from the pinned current
directory. Each descendant transition is verified before mutation. The parent
Runtime never changes its current directory, and unavailable authority fails
closed. Directory inspection uses the same platform-specific authority.

The bundled `local-search` plugin holds the selected file or directory through
a stable descriptor for the complete ripgrep invocation. Linux directory
searches use procfs; macOS searches inherit the verified current directory of
an isolated Node child. File content searches use the held input descriptor on
both platforms. A search fails closed when its authority cannot be established.

Plugins own resource bounds such as filesystem iteration, file/archive input,
collection size, and buffered process output. Passing `context.resultBudget`
lets the shared SDK use the Runtime's final envelope accounting, including
canonical metadata and target references. Without it, the SDK measures the
plugin object and the Runtime checks the canonical envelope separately.
Declared context text is preserved separately from that byte
accounting and remains subject to the complete model-input budget. An explicit
truncated success reports machine-readable truncation metadata; an operation
that cannot produce a truthful result fails explicitly.

The bundled `exec` plugin provides trusted, non-interactive `/bin/bash` execution
on Linux and macOS. Execute, wait and cancel each declare `approval="always"`:
Ask/Full require exact-action approval, and FULL+ skips that extra prompt.
Commands run as the Runtime OS user without lexical path or command-name checks.
The explicit cwd must be an accessible existing directory; relative paths and
`workspace/...` use their configured context bases, while absolute host paths
are allowed. Trusted shell execution is outside the scoped filesystem contract
above; project folders do not sandbox code. Dedicated file-tool restrictions
remain unchanged. Native shell syntax and installed utilities determine command
behavior; process ownership, cancellation, timeout and output limits still apply.

Dev View locators are literal substrings that must identify a unique occurrence
in the bounded file scan. An ambiguous locator remains an explicit failure,
with bounded candidate line ranges and numeric controls for inspecting observed
locations. The caller must omit `locator` when using those numeric controls.
Candidate and scan truncation are explicit; neither previews nor candidate
counts imply full-file coverage.

## Adding A Plugin

1. Create `plugins/<name>/plugin.json`.
2. Implement each declared capability under `plugins/<name>/source/` using the
   Plugin SDK; keep the entrypoint thin and split owners into focused modules.
3. Add the plugin id to the public build only when it is approved for public
   distribution, then run `npm run build:plugins`.
4. Add any referenced `skills/<id>/SKILL.md` files and keep them aligned with
   the manifest and actual handlers.
5. Add behavioral tests for every capability, bounds, path errors, state
   isolation, and mutation evidence. Do not test implementation prose or bundle
   source text.
6. Enable the package through `plugins.allow` if the installation uses a
   restrictive allow-list.

No concrete tool or skill mapping should be added anywhere under `src/runtime`.

### Native Windows plugin support

The native Windows group contains `capability-brief`, `code-outline`,
`document-reader`, `exec`, `filesystem`, `json-inspector`, `local-search`, `memory`, `web`,
`project-orientation`, `system-probe`, and `system`.
Each declares `win32` in its versioned
`ai.abot.compatibility` extension, alongside its existing Linux and macOS support.
Compatibility uses the Runtime process OS, not the browser or a paired computer.
A Windows-only plugin should declare only `win32`; other hosts will not load it.

On native Windows, SYSTEM provides `system_targets`, `system_command`,
`system_applications`, and `system_launch`. Commands run in local PowerShell and
retain existing approvals, cancellation, and protected output handling. Desktop
observation and input (`computer_*`) are excluded from the request catalog in
this phase. Linux/macOS Runtime and WSL/Docker Companion routes retain their
existing capabilities. This phase does not add screenshot OCR.

`system-probe` reports Windows load averages as unsupported instead of presenting
the OS's placeholder zeros as measured load. Its default disk probe uses the
Runtime installation's filesystem; an explicit path selects that path's volume.

`code-outline` uses the SDK's bounded file reader on Windows, with the same
authorized roots, parser and output limits as Linux/macOS. If safe reading is
unavailable, it reports the restriction explicitly and tells the model not to
retry or bypass it. See [Code Outline](../plugins/code-outline/README.md).

`document-reader` uses the SDK's bounded Windows reader for configured paths
and request attachments, with shared text, Office and PDF parsers and limits.
A blocked reader reports an explicit no-retry restriction.
See [Document Reader](../plugins/document-reader/README.md).

`json-inspector` uses the SDK's bounded Windows reader with the existing path,
UTF-8, size and summary limits. A blocked reader reports an explicit no-retry
restriction. See [JSON Inspector](../plugins/json-inspector/README.md).

`project-orientation` uses the SDK's bounded Windows reader for package
metadata and retains its existing directory-tree and result limits. Blocked
manifest reads return an explicit no-retry restriction.
See [Project Orientation](../plugins/project-orientation/README.md).

`local-search` uses native Windows ripgrep through a PowerShell/C# helper that
pins the selected path and owns the child process through a Job Object. Existing
query, output, timeout and cancellation limits still apply. A blocked helper
fails explicitly without a retry or policy bypass.
See [Local Search](../plugins/local-search/README.md).

Enabling manifests alone is not a validation step.

### Shared Computer access

Plugins that need host facilities can import the opt-in
`@abot-ai/runtime/plugin-sdk/computer-access` facade. It exposes native target and
computer backend contracts and the existing bound Companion client. The Runtime
owns installation, pairing and connection lifecycle; plugins must not install
another companion or import another plugin's implementation. Tool permissions,
request disposal, target binding and exact-action approval remain the plugin's
existing execution contract. Disabling SYSTEM does not disable ABot Spark.
