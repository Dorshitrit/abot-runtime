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
connection loss never reconnects or replays a request with an uncertain outcome.

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
immediately when registered after loss. Pending calls reject on connection loss;
the transport never reconnects or replays an uncertain request. A later explicit
connection can acquire an abandoned PID lock and start a new application.

The application boundary must carry ordinary execution, session lifecycle and
scheduler operations together. A scheduler-only proxy cannot protect admission,
session deletion or canonical conversation persistence across processes.
