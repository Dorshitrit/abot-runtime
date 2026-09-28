# Co-worker resource admission

Create one `CoWorkerResourceBudget` per environment, shared by learning and
proactive activity. Its directory must be environment-owned. Quota reservations
are file-lock protected, atomically persisted and flushed before dispatch.
Concurrency is shared by callers of that instance; the runtime environment's
single-owner lifecycle remains responsible for avoiding duplicate background
workers across processes.

`createCoWorkerResourceGateway` wraps only the Co-worker gateway. Every `invoke`
and `invokeRaw` reserves one generative call. Optional `embed` reserves one
embedding call plus the sum of input string lengths. `countInputTokens` passes
through unchanged and does not consume generative or embedding allowance.
All original provider parameters, cancellation and result objects are preserved.

Defaults are 24 generative calls, 96 embedding calls and 1,048,576 embedding input
characters per local day, with one concurrent operation. The embedding limits
are independently configurable implementation safety defaults. Character counts
use JavaScript string length (UTF-16 code units), not bytes or estimated tokens.
These controls are not a monetary, token, RAM or GPU limit.

`assertActivityAllowed` runs before admission, under the quota lock and immediately
before provider dispatch. A disabled activity or closed window blocks every new
call, including later calls from splitting or repair. An already-started operation
settles under its existing abort/timeout contract. Failures never refund quota;
an interruption after durable reservation may conservatively consume allowance
without a provider call. This prevents crashes from resetting admission.

Known cloud calls may share slots up to the configured maximum. Local or unknown
calls are exclusive, including against cloud calls. A busy slot rejects admission
without an internal queue or retry loop; the owning scheduler determines when to
retry. Release is idempotent and is called only after the provider promise settles.

Usage contains one bounded current-day record, not a per-call history. Reading
status and waiting perform no writes and start no timers. Daily rollover uses the
canonical scheduler's calendar/timezone implementation. Changing zones preserves
the current reset; its transition day ends at a midnight in the new zone no earlier
than the old zone's next reset, preventing zone changes from accelerating allowance.
