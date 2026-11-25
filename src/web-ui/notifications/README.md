# In-app error notifications

`WebNotificationService.observeIssue()` accepts a normalized, settled occurrence.
Storage, grouping, counters, read acknowledgement, retention and delivery policy
are shared across sources. Sources own classification and concise user-facing
copy. The Runtime core does not identify model names or interpret provider text.

To connect another source:

1. Classify the failure in its owning adapter and produce allowlisted facts.
2. Allocate one internal occurrence ID and timestamp when the issue begins.
   Preserve both through retries and replay; report the final outcome once.
3. Build a `NotificationIssueOccurrence` with the environment, source namespace,
   stable cause, affected provider/profile, remediation target and only the
   configuration fields that change the remedy. Session/request references are
   optional. Do not include prompts, credentials or raw provider responses.
4. Call `observeIssue`, or add a small source projector alongside
   `issue-source-projection.ts` when using the existing committed event stream.
   Use existing typed action kinds; a new action needs its own validated handler.

The sources are model-step timeouts, adapter-observed reasoning rejections, and
local parameter omissions. Provider reasoning rejection is settled after stream
completion or valid token-count parsing; HTTP 200 alone does not establish recovery. Diagnostics travel separately
from model content. No issue can be reconstructed when the connection ends before
the client receives its metadata. Replay is not a backfill source.

Local omissions report one occurrence per model call with a bounded set of
registered parameters, safe scalar values and fixed omission reasons. The entire
sorted set participates in grouping. Their `recovered` outcome means only that
the local settings adjustment completed; it does not claim provider rejection or
request success. A later unrelated request failure retains its own notification.
Intentional omission and a valid parameter mapping do not create this issue.

## Grouping and acknowledgement

Group identity includes source, provider, profile, cause, remediation target and
sorted relevant configuration; environment stores are separate. A recurrence
increments the existing group and reopens it unread. Duplicate delivery does not
increment or reopen it. A recreated group receives a new UUID after eviction.

Single-item reads acknowledge the observed occurrence count. Mark-all reads carry
the server snapshot boundary. Newer occurrences remain unread, and old clients
without this evidence cannot mark grouped errors read. `createdAt` stays fixed;
the last occurrence has a separate timestamp. Existing 90-day / 1,000-record
retention applies to read and unread groups alike. Home uses the server's total
unread error-group count, independently of inbox pagination.

## Bounded duplicate protection

Each environment retains at most 10,000 compact SHA-256 occurrence receipts for
90 days, independently of notification records. Receipt and group updates, read
state and admission floor are saved in one atomic transaction. Sources must not
restamp duplicate observations.

Eviction advances a persisted, monotonic floor ordered by original timestamp and
hash. Events at/below that floor, outside the age window or in the future are
rejected. This prevents old evicted duplicates from being recounted, at the cost
of also excluding genuinely delayed events below the boundary. Clock rollback and
same-millisecond ordering can narrow coverage. This is bounded admission, not an
exhaustive 90-day occurrence ledger. `issueCoverage` exposes the limit, floor and
rejection counters without recursively creating notifications.

The live collector coalesces observations and writes batches of at most 256. Its
pending queue is capped at 10,000 identities per environment; failed writes retain their batch,
and overflow is counted. Queued observations are memory-resident until flushed;
there is no durable outbox or historical log scan. Error groups always remain
in-app, independently of desktop preferences. Exact causal issue IDs suppress
only the corresponding generic terminal notification.

Environment write lanes are independent: a broken or full collector in one
environment cannot block listing, acknowledgement or collection in another.
