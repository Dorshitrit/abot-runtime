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

## Manifest Contract

`@abot-ai/runtime/plugin-sdk` is the single public plugin-authoring entrypoint. It
exports the manifest constants and types, entrypoint contract, and bounded
authoring helpers consumed by plugin implementations.

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

Supervisor routing receives one optional, passive text brief from the same
request-filtered registry used by `capability-brief`. It chooses the richest
complete representation that fits: tool names with operation ids and groups,
tool names by group, group counts and effects, or no brief. The brief replaces
the previous aggregate catalog text; group ids remain in the response schema
in every mode. It includes no tool descriptions, inputs, or operating
instructions. Its 512-token estimate ceiling is further reduced by existing
context headroom, including history and instruction reserves. No subset of
tools is selected to fit, and no model call summarizes the catalog.
This admission uses the context estimate at projection time. A later provider
token count, steering update, or structured-output repair can still trigger
the existing context-compaction path; the brief is not reselected there.

The SDK exports `buildToolAvailabilityBrief` for the unchanged on-demand plugin
output and `buildToolAvailabilityOverview` for informational representations.
The runtime context helper owns token admission and the passive reference
message; another step can explicitly attach it using the existing context
reference API. Supervisor's working-directory and response phases do not
receive it. Planner retains its existing group-routing projection.

Under `execution-agent-v1`, the canonical root receives group descriptions
generated from member capability ids and summaries, and may mechanically open
or extend its own RoleCall scope.
It then selects a concrete capability only from that active scope. Scope
updates, capability binding, payload authoring, adapter execution, and
settlement use the same ledger and capability engine as delegated Worker
execution. Unknown, empty, invalid, repeated, or no-op scopes are rejected
rather than widened to the full catalog. A request with no Worker capabilities
may still invoke an unscoped Worker for a knowledge-only result.

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
instances, or other non-plain prototypes. The complete normalized result must
fit the Runtime's 256 KiB serialized producer boundary. A plugin must return an
explicit bounded or paginated result, or an explicit failure; neither the
plugin nor the Runtime may silently remove structured facts.

`ToolRegistry` adds the selected tool identity and creates the canonical
`ToolExecutionResult`. The Runtime validates and persists that complete result,
then projects it only to the exact root or Worker call that produced it and to
later payload authoring in that same call. A conforming new plugin therefore
works across direct and delegated execution without capability-specific
projection code under `src/runtime`. Result contents are model-facing evidence:
they must not include secrets and they never act as instructions, new user
intent, or proof that the whole request completed. See
[tool-execution-result-evidence-contract.md](tool-execution-result-evidence-contract.md).

## Filesystem Roots

`environment.paths.agentWorkDir` is the configured primary work root. Plugins
must resolve user-controlled filesystem targets through the injected
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
I/O. Plugins must not infer or advertise a physical `sandbox/` alias.
Attachment handles are a separate request-owned source and are not converted
into ordinary filesystem targets.

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

All output and structured data must be bounded at the producer. The shared SDK
reserves wrapper headroom by rejecting plugin results above 128 KiB before they
reach the Runtime's 256 KiB canonical settlement boundary. Bounds include
filesystem iteration, file/archive input, collection size, individual labels,
and rendered text. A truncated success reports machine-readable truncation
metadata; an operation that cannot produce a truthful bounded result fails
explicitly.

The bundled `exec` plugin supports Linux and macOS with non-interactive
`/bin/bash`. Commands must use utilities available on the host. Its configured working directory is constrained to
agent-work or workspace roots, but the shell runs with the Runtime process
permissions and is not an operating-system sandbox.

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
