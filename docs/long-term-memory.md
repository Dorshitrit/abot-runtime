# Passive Long-Term Memory

ABot Runtime can retain selected user facts and preferences across sessions.
This feature is passive: the model does not invoke a memory tool, and the
Runtime core remains the only owner of retrieval, filtering, deduplication,
storage, and deletion.

Long-term memory is disabled by default. Enabling it is an explicit consumer
choice because it may persist personal information between conversations.

## How It Works

The Supervisor path separates memory proposal from the user-facing response.
When long-term memory is enabled, `supervisor.response` first performs one
structured candidate-only call:

```json
{
  "memoryCandidates": [
    {
      "content": "A durable fact or preference established by the user.",
      "tags": ["normalized-later-by-core"]
    }
  ]
}
```

`memoryCandidates` is empty when there is nothing durable to propose. The
Supervisor then authors the complete user-facing response through its ordinary
raw-text contract, without a JSON wrapper. Invalid or unavailable candidate
authoring is isolated to an empty candidate list and cannot replace or
invalidate that raw response. This sequential split adds the candidate-call
latency before the Supervisor response is delivered.

`execution.response` retains the combined strict envelope containing both
`finalResponse` and `memoryCandidates`; its external response contract is
unchanged.

Candidate data remains internal and is processed after the final assistant
response is persisted. Persistence runs through a Runtime-owned background
queue; response completion never waits for embedding or memory-store work.

Before the next terminal response is authored, the Runtime retrieves a small
relevant set from the cross-session pool. Retrieval uses provider embeddings
plus bounded lexical, tag, and recency scoring. The projection is passive
reference context; it is never treated as a new user request or an instruction.

Retrieval, candidate policy, filtering, deduplication, and persistence are
shared by `supervisor.response` and `execution.response`; only their authoring
contracts differ. Decision, planning, Worker, Reviewer, payload, and tool
contexts do not receive the long-term memory projection.

Both response paths also share the same configured response-experience
methodology. It applies whether memory is enabled or disabled. Relevant memory
is an optional passive layer that may improve continuity and useful defaults;
it never replaces the current request, forces a personal reference, or grants
action authority.

## Enable It

Configure an ordinary model provider first with `abot init` or `abot add-model`.
Then choose an embedding model exposed by that provider. ABot does not choose,
install, or download an embedding model.

For a packaged installation:

```bash
npx abot memory status
npx abot memory models --provider <provider-id>
npx abot memory enable --provider <provider-id> --model <embedding-model-id>
```

From a source checkout, use the equivalent commands:

```bash
npm run memory -- status
npm run memory -- models --provider <provider-id>
npm run memory -- enable --provider <provider-id> --model <embedding-model-id>
```

Add `--emit-events` to expose bounded lifecycle events to clients. Enablement
performs a real embedding probe and validates the complete candidate config
before writing it. The previous config is backed up, and a restart is required
after enablement or disablement.

The Config workspace in the packaged Web UI uses the same onboarding service.
It can list configured providers, discover models when the provider supports
discovery, probe and enable a selected model, or disable the feature. A provider
without discovery support accepts a model id entered by the user.

## Configuration Contract

The onboarding flow writes a dedicated embedding profile and binds the feature
to it:

```json
{
  "models": {
    "embeddingProfiles": {
      "memory-embedding": {
        "label": "Long-term memory embeddings",
        "provider": "ollama",
        "model": "<embedding-model-id>"
      }
    }
  },
  "longTermMemory": {
    "enabled": true,
    "emitClientEvents": false,
    "embeddingProfileId": "memory-embedding"
  }
}
```

Embedding profiles are intentionally separate from generation profiles. They
accept `provider`, `model`, optional `label`, and provider-owned JSON-safe
`options`; generation, reasoning, context-window, and output settings are not
valid embedding-profile fields.

When disabled, no repository read, embedding request, model-output envelope,
or memory lifecycle event is added to the response path.

## Providers

- Ollama uses its `/api/embed` contract and can discover locally installed
  model ids through `/api/tags`.
- OpenAI uses `/embeddings`. Model discovery is not exposed by that provider,
  so the consumer supplies the embedding model id.
- A custom model-gateway adapter may implement `embed` and optional
  `listEmbeddingModels` without changing Runtime memory policy.

If the selected embedding provider becomes unavailable during a request, the
Runtime skips memory retrieval or persistence, records a bounded diagnostic,
and preserves normal response delivery.

## Storage, Privacy, And Management

The default adapter stores canonical records and their derived vector index at:

```text
<runtimeDir>/long-term-memory/memory.json
```

The file is runtime-generated local state and must not be published or
committed. Canonical records contain content, normalized tags, timestamps, and
source session/request provenance. Derived vectors are versioned by model
fingerprint and are rebuilt when that fingerprint or vector dimension changes.

The core rejects obvious secrets such as private keys, labeled passwords, API
keys, and common token formats. Exact duplicates are merged mechanically;
semantic similarity alone never overwrites an existing record.

Library hosts can manage the pool through the composed service:

```ts
const runtime = createRuntimeApplication(config);

await runtime.services.longTermMemory.status();
await runtime.services.longTermMemory.list({ limit: 50 });
await runtime.services.longTermMemory.delete({ id: memoryId });
await runtime.services.longTermMemory.clear();
```

Management APIs return canonical records, not embedding vectors.

## Client Events

With `emitClientEvents: true`, clients may receive bounded lifecycle events:

- `memory.retrieval.started|completed|failed`
- `memory.save.queued`

The save event confirms only that background persistence was scheduled. Its
completion or failure is diagnostic-only and cannot change the completed user
response. Client events contain lifecycle status and counts only. They never
include memory content, tags, vectors, credentials, or the model's internal
candidates.

The bundled `memory` plugin remains a separate, explicit user-invoked
capability. Passive long-term memory does not depend on that plugin and remains
operational if the plugin is disabled or removed.
