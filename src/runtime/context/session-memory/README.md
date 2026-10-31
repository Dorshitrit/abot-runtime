# Session conversation memory

The session-memory controller owns history selection, compaction admission,
checkpoint preparation and commit, and approval snapshots. Both execution
policies use this controller. A policy-specific scope selects the source and
checkpoint; it does not create another request loop or compaction engine.

## Policy boundary

`request/prepared-execution.ts` chooses the scope from the frozen execution
policy for a fresh request. The shared predicate in `../execution-history-policy.ts`
also gates capture and payload consumption. Approval continuation restores the saved scope.
An old snapshot without a scope retains its original conversation-only behavior.

| Contract | Default / SUPER | `execution_agent` |
| --- | --- | --- |
| Source | Original conversation text | Same conversation plus bound EA tool observations |
| Checkpoint field | `sessionMemoryCheckpoint` | `executionSessionMemoryCheckpoint` |
| Source fingerprints | Existing conversation fingerprint | Also includes the recognized observation bytes |
| Recent settled turns | Ten protected turns | May be compacted when normal admission requires it |
| Summary author | Existing policy-selected author | Existing session summary author, with tool facts included |

The default scope never reads EA observations or the EA checkpoint. Clearing
history or deleting a turn invalidates both checkpoints. Checkpoint CAS still
uses the session store's existing mutation boundary, source revision and
checkpoint revision. No EA checkpoint is copied into the default slot.

## Evidence path

`steps/execution-agent/history-observation.ts` captures settled root tool
results into the existing assistant-message `observationContent`. When the
current request already has an applicable, fingerprint-matched result digest,
that digest is the captured representation. Otherwise the canonical result is
captured. Tool execution IDs, outcomes and references keep their provenance;
old results do not become current-request executions or completion evidence.
Request-scoped image handles expire at request disposal and are omitted; their
textual tool result remains available in history.

`sessions/memory/execution-observation.ts` recognizes that versioned content
and binds it to its original request. EA history projection places the original
assistant response and observations in one explicitly passive historical
message. Stored conversation text is unchanged. EA decision/response retain
this conversation projection.

`execution-reference-memory.ts` supplies Controls and root payload authoring
with a narrower passive reference segment. It retains their existing exact
request and latest uncovered plain conversation pair, then adds only retained
tool observations and an existing checkpoint when its coverage includes those
observations. Earlier ordinary conversation is not replayed as user/assistant
messages. An intervening turn does not discard the tool facts. The checkpoint
is the existing lossy mixed summary; this view does not invent tool-only facts
or select semantic relevance from it. All retained observations are available
as reference data for the accepted assignment, never as current executions.

Without recognized observations, and for legacy snapshots without EA scope,
Controls and payload authoring keep their original context and compaction path.
The reference segment includes the preceding pair so compaction replaces that
pair together with the tool sources it covers; raw covered history is not kept
beside its summary. The original controller remains the sole checkpoint owner,
and both views share its preparation, commit and approval snapshot.

Normal context admission triggers compaction. The summary replaces covered
history and includes tool-derived facts. An oversized EA turn is folded through
the same summary author in contiguous Unicode-safe fragments; all bytes are
consumed and no archive, recovery catalog or attachment reread is introduced.
Summary generation remains lossy, as ordinary conversation compaction is.

`execution-coordination.ts` isolates coordination for parallel EA payload
authors: they share one request-local preparation and its exact CAS result.
Admission refreshes only committed history if a peer advances the checkpoint.
Uncommitted candidates never enter approval snapshots. The default/SUPER
controller keeps its existing preparation and commit behavior.

## Regression boundaries

The focused `execution-history-*` and `execution-session-memory-scope` tests
cover tool-only facts absent from assistant prose, intervening turns, compacted
history, large source coverage, persisted/approval restore and downstream
consumers. Negative controls cover empty and ordinary EA history, old approval
snapshots and passive-reference topology. `sessions/memory` tests cover source
binding and both store backends.
SUPER controls compare ordinary source hashes, history projection and payload
messages, including a conversation that already contains EA observations and
an EA checkpoint. The existing SUPER compaction author and approval routing
remain covered by their existing suites.
