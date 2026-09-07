# Local scheduler

This environment-owned service persists Jobs and run records independently of
Socket and plugins. It invokes an injected executor; that adapter must reserve
the same session admission boundary used by ordinary Runtime requests and submit
the saved prompt through the canonical request path.

## Ownership and lifecycle

Call `start()` before management. Calls are serialized, so management queued after
`start()` waits for startup. Startup acquires one local process ownership lock for
the storage directory. A second owner fails with `scheduler_store_in_use`; it
must not start another clock or silently select a different store. This reuses
the existing atomic PID lock primitive. There is no multi-host lease protocol.

`stop()` invalidates preparations immediately and waits only for queued
preparation/storage work, not active requests. A generation guard prevents
asynchronous startup from reactivating a stopped service or old completions from
settling into a restarted generation. Startup marks previously running requests
`interrupted`, drops pending offline occurrences as `missed`, and advances active
Jobs to their next future occurrence. It never retries an interrupted or failed
request or backfills missed occurrences.

A session deletion reserves its start barrier synchronously, including while
startup is queued. Passing the running-state check confirms deletion; a rejected
lifecycle call releases only its own reservation. A storage failure after
acceptance keeps the deletion barrier; explicit deletion can finish cleanup
without admitting new runs for the deleted session.

Jobs and runs are stored in immutable transaction files selected by
`scheduler-journal.json`. Serialized commits use fsynced temporary files and
atomic rename. On POSIX, each rename is followed by a containing-directory fsync:
transaction and checkpoint entries are durable before the manifest is replaced,
and the manifest directory is synced before acknowledging a commit or retiring
old files. New generation/checkpoint directories are synced through their parents.
Owned acquisition validates the loaded head, then syncs its checkpoint directory,
generation directory, root path and ancestors before exposing the store or cleaning
the journal. This also establishes entries written by older versions and directories
left by interrupted initialization, without scanning historical transactions. POSIX
directory-open/sync errors propagate; ancestors must permit opening for sync.
Windows retains file sync and atomic replacement without a directory-fsync guarantee.

If the manifest replacement succeeds but its directory sync fails, the outcome
is uncertain. The owned store rejects further cached reads, writes and cleanup
until explicitly released and reacquired; it does not retry a mutation or dispatch
an unconfirmed claim. Both old and new files remain available. Reacquisition validates
and syncs the visible head and its directory dependencies before cleanup.
These barriers rely on the filesystem and device honoring fsync; they are not a
backup or repair mechanism for pre-existing corruption.

Normal ticks read Jobs and active runs and persist only changed
records; completed prompt/result payloads stay on disk. History queries select
run metadata before loading the requested payloads. History is never pruned.

The version 3 manifest records the committed transaction sequence and one
immutable checkpoint. Startup restores Jobs, active run payloads and compact
archived run metadata, then reads at most 256 exact transaction paths. It does
not enumerate the historical transaction directory or reread old prompt/result
payloads. The compact index still grows with the number of retained runs;
checkpoint loading and periodic index serialization therefore have metadata-sized
cost, while full historical payloads remain lazy.

A transaction becomes committed only after its durable file and the atomic
manifest replacement succeed. An unpublished tail is ignored on restart and
replaced by the next committed transaction at that sequence. Checkpoints are
published before the next logical mutation once the suffix reaches its bound;
checkpoint failure cannot turn an already committed mutation into a failure.
Only superseded or unpublished checkpoint artifacts are cleaned up at this
boundary. Archived transaction payloads stay available until explicit session
deletion. Concurrent unowned reads retry when a generation or checkpoint is
retired, while ordinary appends preserve the captured immutable snapshot.

The first owner migrates an existing `scheduler.json` without discarding history.
Existing version 2 journals replay once before publishing their initial version 3
checkpoint. A failed upgrade leaves the previous format authoritative; missing or
corrupt required version 3 files fail rather than falling back to replaying an
uncommitted tail. Older binaries that only support version 2 cannot open version 3.
Migration and deletion publish a complete new generation through one atomic
manifest replacement, then remove the superseded files. A failed cleanup remains
discoverable on the next owned operation. Concurrent reads cannot return partial
generations. Corrupt data is rejected, not silently reset. The public store's
default read/update view remains the complete snapshot; its optional `active`
view and `readRuns` path support efficient scheduler transactions and history.

If writing an executed run's terminal status fails, `run-completion.ts` retains
that captured outcome and its original completion time in the current service
generation. Each normal tick attempts those writes once before dispatching more
work; a failed terminal write does not prevent unrelated sessions from dispatching.
This only reconciles storage and never repeats the executor or model request.
Cancellation and pause preserve outcomes of already-started runs. Session deletion
or stop invalidates retained outcomes, and reconciliation never creates a missing
run. A process restart retains the existing `interrupted` recovery policy.

## Time and admission

The schedule contract accepts typed timer, once, interval, daily, weekly, and
monthly forms. Calendar forms require an exact `HH:mm` time and an explicit IANA
time zone. Once timestamps require an explicit UTC offset. Timer and interval
durations use integer milliseconds of at least one second. The default first
interval occurrence is creation plus the interval, persisted as an explicit
anchor.

New and changed timers derive their deadline from the acceptance clock plus
`delayMs`. Timer `at` is stored metadata; caller-supplied `at` cannot replace the
deadline or bypass duration overflow checks. Reading or restarting a stored timer,
metadata edits and an exactly unchanged stored schedule preserve its deadline.

New intervals and interval reschedules require their first two future occurrences
to fit the canonical four-digit-year ISO range. Existing intervals remain
readable and complete when no later occurrence fits that range; one exhausted
interval cannot block another Job or startup recovery. The Web editor retains
the exact saved interval anchor when its displayed field is unchanged, including
seconds, milliseconds and the selected occurrence of a repeated local time.

Calendar conversion uses `Intl.DateTimeFormat` from the host's IANA time-zone data.
Missing wall times/days are skipped; repeated local times select their first
occurrence once. Intervals preserve elapsed-time cadence across DST.

An online late tick advances to the next future occurrence after creating at most
one pending occurrence per Job. A busy session leaves that occurrence pending.
If a manual run occupies that slot, the ordinary due time remains unchanged
until it can be recorded as scheduled work. Run now cannot consume an ordinary
occurrence, and additional due times still coalesce to one scheduled occurrence.
Cancellation, pause, update, and session deletion invalidate preparation before
any awaited work can cross the final synchronous start boundary. Cancellation or
session deletion never interrupts an already started request. Session deletion
removes its Jobs and run records; late completion cannot recreate them.
Pausing again cancels a pending manual run even when the Job is already paused.
It leaves an already-started run alone; a later explicit Run now is still allowed.

Run records keep immutable prompt, title, model profile, agent mode, time zone,
and Job revision snapshots. A non-timing edit replaces pending work with a fresh
snapshot while preserving its original due time and trigger. Timing edits
reschedule it; empty and identical edits preserve its identity. Already-started
and completed history is unchanged. Resume preserves manual pending work.
Time-zone edits reschedule only calendar forms. Timer, once, and interval forms
keep their due time and trigger while replacing pending snapshot metadata.

A failed session lookup fails only that occurrence, records its error without
retry, and allows other pending runs to dispatch. Future recurrences remain
active. A missing session still removes that session's Jobs and run records.

The Runtime adapter owns canonical session deletion checks and persistence guards.
Preventing late persistence alone is not sufficient: it must also reserve
admission and reject a deleted session before executing its request.

## Source layout

- `contracts.ts`: public domain contracts.
- `scheduler-service.ts`, `service-context.ts`: lifecycle and serialized service.
- `job-management.ts`: CRUD and management state transitions.
- `scheduler-engine.ts`, `run-records.ts`, `startup-recovery.ts`: occurrence and
  run lifecycle.
- `schedule-validation.ts`, `instant-validation.ts`, `validation-error.ts`:
  typed input validation.
- `calendar-time.ts`, `next-occurrence.ts`: deterministic recurrence.
- `file-store.ts`: process ownership and serialized storage access.
- `journal-store.ts`, `journal-files.ts`: incremental commits and generation replacement.
- `journal-durability.ts`: ordered file/directory publication and uncertain-sync errors.
- `journal-index.ts`, `journal-transaction.ts`: indexed history and validated changes.
- `journal-head.ts`, `journal-checkpoint.ts`, `journal-index-state.ts`: committed
  sequence, bounded startup replay and validated compact index persistence.
- `working-store.ts`, `snapshot-validation.ts`: active view and snapshot validation.

The model and Web layers share this service. Natural-language interpretation,
model choice, conversation projection, and UI rendering do not belong here.
