# Local environment ownership

Installed applications use `createLocalRuntimeApplication(config)` from
`@abot-ai/runtime/runtime`, followed by `await application.start()` and
`await application.stop()` during shutdown. Web and Bridge use this managed
facade automatically. No manual port or Launcher setup is required.

`loadRuntimeConfig` gives named environments separate state namespaces when they
inherit a runtime base or share `LLM_RUNTIME_DIR`. The namespace uses only the
stable environment ID; owner attachment still checks the complete resolved
configuration. A changed model configuration therefore cannot create a second
owner over the same state. Explicit per-profile roots and the no-profile layout
remain unchanged. Populated legacy bases require an explicit assignment and
are never moved automatically; see [environment paths](../../../docs/configuration.md#environments).

A manually constructed `RuntimeConfig` supplies already-resolved final paths.
It is used unchanged by both managed and embedded factories. Such hosts must
provide distinct runtime, session, attachment and trace paths for distinct
environments, or use `loadRuntimeConfig` to resolve inherited bases consistently.

Use `application.requests.steer(requestId, update)` for the owner's canonical
steering acknowledgement. Request options may supply an initial steering prefix;
subsequent updates use the asynchronous method. The raw embedded factory keeps
its adapter injection semantics and must not be started over storage already
owned by a managed application.

The managed local entrypoints share one environment owner. The embedded
`createRuntimeApplication` remains the in-process core; this boundary transports
calls to that same core without moving orchestration or scheduling policy into
the transport.

`createLocalRuntimeConnection` accepts a private directory, resolved environment
identity and an owner factory. The first connection acquires the existing atomic
PID lock and invokes the factory once. It publishes an authenticated loopback
WebSocket endpoint on an ephemeral port. Later connections attach to that exact
owner and reject a different identity. Concurrent startup waits only for initial
endpoint establishment, with a bounded timeout. If the observed owner disappears
before the WebSocket handshake completes, startup returns to owner election
within that same deadline. Authentication, identity and private-access failures
remain terminal.

If initial startup fails before a connection is established, a later explicit
`start()` or service call can start a fresh connection attempt. Concurrent callers
share the current attempt. No attempt is repeated automatically, and an established
connection loss never replays a request with an uncertain outcome. Ordinary service
calls retain the failed connection. Explicit approval access may reconnect to the
same captured owner endpoint; it never elects a replacement owner or resends a run.

## Saved ASK approvals

Web requests opt into `durableApprovals`. When approval is the only remaining
work, the request saves an `awaiting_approval` interaction in its existing session
record and returns. Its runner, request RPC, approval callbacks, timers and tool
resources retire. Restart leaves this saved response pending. Startup interrupts
previously running durable activations; it never replays them.

The session record owns the lifecycle, approval descriptions, decision receipts
and event sequence. Immutable content blobs beneath the session store hold the
versioned continuation, including the role ledger, prepared actions, history and
request resource data. These blobs cannot authorize execution on their own.
Session replacement syncs file data and its directory on supported platforms;
Windows power-loss durability remains dependent on filesystem guarantees.

`application.approvals.list()` reads pending metadata without loading a
continuation. Saved-wait `attach(...)` only acknowledges availability. A decision
includes `generation`, `waitId`, `revision` and a stable `commandId`, in addition
to session, request and approval IDs. Partial decisions remain saved. The final
decision validates compatibility, atomically consumes the wait and claims a new
activation, then resumes the same runner at the exact prepared action. Repeated
decision commands return the saved receipt. A group dispatches only after all
its decisions are recorded. No model decision or payload preparation is replayed.

An incompatible or unreadable continuation stays pending and can still be
cancelled. Explicit cancellation is distinct from tool rejection. A crash after
the activation claim interrupts that activation even if dispatch has not started
or its external effect is uncertain: the runtime does not promise exactly-once
external effects or automatically repeat such work.

While a saved wait exists, the Web composer is frozen and a new request or
scheduled job in that session is not admitted. The user can cancel the waiting
request and start another. Previously admitted requests and other sessions retain
their existing concurrency. Active background tool work keeps its request live;
the request parks when that work becomes quiescent.

## Legacy approval clients

Clients without `durableApprovals`, including existing Bridge and scheduler
callers, retain live-owner approvals. Elapsed time and connection loss cannot
become a user rejection. Their `attach(...)` restores delivery before a late
decision; stale callbacks cannot decide after replacement. Scheduled requests
keep their existing broadcast delivery. Saved approval events from older versions
do not contain a continuation and cannot be migrated into resumable permission.

If the connection closes before an approval notification arrives, an
approval-capable client request remains unconfirmed until explicit approval
access checks the same owner's state. An empty approval list is not completion:
the client retains the request while the owner's exact request/session remains
active. Older reads cannot replace newer callback or attachment observations.
This reconciliation never runs a request again or elects a replacement owner.

Legacy request timers exclude approval waits, including overlapping approvals.
Durable requests preserve their remaining active-time budgets across saved waits;
time with actual work still in flight continues to count. Owner shutdown aborts
live execution with `request_interrupted`, without recording a rejection. Saved
waits have no live execution to abort.

The endpoint contains a random token and is private to the local user: Unix
directories/files use 0700/0600 and ownership checks; Windows directories are
prepared with a current-user ACL before an atomic installation, and directory
and endpoint ACLs are checked before reading credentials. Existing nonprivate
paths and symbolic links are rejected. There is no network listener beyond
127.0.0.1 and no dependency on an external bridge.

The binary RPC protocol preserves canonical Date, Buffer and undefined values.
Errors preserve message, name and string code without copying remote stacks.
The application dispatcher owns its explicit method allowlist. Bidirectional
peer calls carry request events and approval/steering callbacks; broadcasts are
projections of owner events and do not create another state store.

An owner connection's `close()` stops intake and scheduling and closes its
transport without waiting for active model requests to drain. Queued ordinary
requests and requests still awaiting peer acceptance cannot start after this
boundary. The endpoint is removed immediately, but the owner's PID lease stays
held until in-flight RPC calls, ordinary requests and scheduled reservations
actually settle. A replacement managed owner can then start; shutdown never
replays interrupted work. A real process exit permits abandoned-PID recovery.
After intake closes, the canonical owner's synchronous activity and admission
snapshot identifies an already-idle owner. Its `close()` awaits the idle fence
and physical lease release before returning; active owners retire separately.
Physical release of this long-lived owner lease is synchronous once the idle
fence settles. Graceful `process.exit()` cannot interrupt removal between the
token marker and its empty directories, leaving a spurious incomplete lease.
Other file locks retain their existing asynchronous release behavior.
The embedded factory remains outside managed ownership and must not be started
over a managed environment's storage, including while its owner is retiring.
A client connection's `close()` only detaches that client.
Detached passive-memory saves retain their existing background queue and
independent repository locking; they are not part of request admission.
Both are idempotent. `onClose` fires on local closure or connection loss and fires
immediately when registered after loss. Pending RPC calls reject on connection
loss; the managed client retains an ordinary request waiting for approval until
explicit attachment or local shutdown. The transport never replays an uncertain
request. A later explicit new application can acquire an abandoned PID lock and
start a new owner; approval reconnection is limited to the original owner.

The application boundary must carry ordinary execution, session lifecycle and
scheduler operations together. A scheduler-only proxy cannot protect admission,
session deletion or canonical conversation persistence across processes.

Managed applications expose an idle-only configuration lifecycle boundary:
isOwnerIdle observes the owning connection's activity/admission fence, and
stopIfIdle closes intake in the same JavaScript turn as that check. Busy owners
and attached clients return false without stopping work. This allows a local
host to explicitly replace its own idle application after a configuration edit
without using a browser activity list as shutdown authority.
