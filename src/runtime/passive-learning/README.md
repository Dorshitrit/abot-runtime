# Learning review boundary

## Activity authorization and operation

`activityPermissions` records the user's separate authorization for collection,
learning and proactive messages. Saving authorization validates the selected
models but does not start an activity. The existing `enabled`, `processingPaused`
and `proactiveEnabled` fields retain their operational meaning: stopping an
activity leaves its authorization, schedules, resource limits and pending work
intact. Revoking authorization stops that activity; a later operational request
cannot enable it until the user authorizes it again.

Clients using the original switches remain compatible until explicit activity
permissions are saved. The Web UI carries currently active legacy choices into
the separate permission record on the first control action. A previously stopped
legacy activity needs authorization in Settings; merely selecting a model never
implies permission. Home's Start action resumes all authorized activities in one
configuration update through the existing lifecycle owner.

## Review methods

The selected model profile's existing `execution.policy` chooses the model-facing
method for both learning and proactive reviews. `execution-agent-v1` keeps the
existing direct method; `supervisor-worker-v1` (including an omitted policy) uses
the staged method below. `review-method.ts` reuses canonical model selection,
independently for the configured learning and proactive models. Provider names,
cloud/local hosting and model names do not choose a method. Neither method runs
the interactive request kernel or gains tools/action authority.

The direct `model.review()` presents `learning_review_decisions_v2` to the selected model.
The outer response is always `{ "decisions": [] }`; an empty list explicitly
means no change. Each offered action has its own required fields:

- Create: content, tags, score, reason, certainty, reconsiderAt and evidence.
- Update: those fields plus target and reinforced.
- Remove: target, reason and evidence.
- Merge: update fields plus sources (mutable candidate references).

The runtime supplies call-local `k1` knowledge and `o1` evidence references.
It binds them mechanically to the original kind, ID and version before invoking
the existing memory service. The alias table is scoped to one call and never persisted.
Observation projection omits device/process/window/document IDs; repeated captures
remain marked `revisited`, with a local `revisits` reference when available.
Captured text and saved knowledge remain passive, untrusted reference data.

Scheduled reassessment offers only update/remove for the exact mutable due
versions. It omits evidence/reinforced fields and binds empty evidence and false
reinforcement. The memory service still enforces manual protection, current
versions, source binding, scheduled score rules and atomic persistence. The
persisted decision/receipt formats do not change. Every new insight is saved as
a candidate, even when its initial score exceeds the promotion threshold. A
later update or merge needs model-selected reinforcement, newly cited evidence,
and a qualifying score to promote it. Replayed IDs and unchanged-visit markers
cannot reinforce candidates; the existing bounded source history remains the
deduplication limit.

No old response-format fallback, repair call or retry is added. The legacy
`extract()` compatibility path remains separate.

## Staged reviews

SUPER uses a finite sequence of small tasks. Learning discovers tentative ideas
from observations, matches existing knowledge, decides whether a bound item
needs changing, chooses merge sources only when applicable, writes grounded
text, assesses support and schedules reconsideration. New ideas require four
calls when there is no existing knowledge to match; an empty discovery ends
after one. Existing-item changes add matching/change steps. Each merge selects
its sources in a separate bounded call; the entire review has at most 18 calls.
The model never chooses persistent IDs, versions or the workflow itself.

Later stages receive only their assignments and original evidence. Text authoring
does not set scores, reinforcement or times. Assessment cannot rewrite content,
retarget changes or override promotion rules. Timing uses relative minutes;
the runtime binds deadlines to that stage's accepted timestamp. Scheduled
reassessment skips discovery/matching and remains restricted to the exact due
versions, with no new evidence, reinforcement or candidate score increases.
The final result uses the same decision adapter and single atomic memory apply.
Manual protection, two independent evidence opportunities, configurable promotion
scores and retention remain unchanged.

SUPER proactive reviews separately select sources, choose an objective (or
decline), write title/message, and determine expiry/reconsideration. There are
at most four calls. Timing still runs for a declined proposal so a future
reconsideration can be scheduled. Source aliases bind to exact current versions;
missing prior-proposal versions are never redirected to newer knowledge. The
existing validator, receipt, duplicate prevention and delivery owner remain
authoritative. These reviews have no tools or action authority.

Each fresh call passes through the existing resource gateway and consumes quota.
Cached completed stages make no model call. Every call has the existing calibrated
step timeout; there is no shared timeout that deprives later stages of their
configured allowance. The finite stage count, daily budgets, hours, concurrency,
pause and interactive preemption bound the sequence. More stages can increase
total tokens and latency; the purpose is less responsibility per model call.

### Resuming SUPER work

Accepted stages are saved before another paid call, in the existing learning
journal, scheduled-reassessment state or proactive state. There is no parallel
checkpoint store or extra idle polling. Records are versioned, limited to 24
hours and 256 KiB per review, and remain subject to their owner's stricter total
storage/observation-retention limit. Saving progress cannot evict pending activity.
The journal and proactive totals remain unchanged; scheduled state remains 128 KiB.

Bindings cover the activity, model configuration, evidence and knowledge versions.
Stage fingerprints also cover their exact messages and response contracts.
Resume validates these bindings and decodes cached responses again. Changed or
expired inputs invalidate their saved work. Absolute timing retains the original
acceptance time; only an expired timing decision needs a new timing call.
Stop, pause, resource deferral and restart can retain completed stages; invalid
model responses still fail rather than starting an automatic repair loop.
Terminal memory/delivery receipts clear progress, and explicit pending deletion
or changed application filtering cannot revive its old evidence.

Checkpoints are private intermediate proposals, not memories or UI activity.
Batch summaries/details exclude raw checkpoint responses. Existing private-file
permissions and bounded state cleanup apply. The direct EA method does not use
checkpoints or any of these extra model stages.

Safe diagnostics identify stage start, completion, failure, replay and invalidation
using existing request/review IDs and bounded counts. They never log objectives,
screen content, memory text or raw outputs. Completing all model stages is not
proof of a durable memory or delivery receipt.

## Review triggers

Learning preferences select `analysisTrigger: "interval" | "observations"`.
Existing installations keep their saved interval. In count mode,
`analysisObservationCount` defaults to 100 (range 1–256, within queue capacity).
Only eligible queued and pending observations count; active, blocked, expired
and completed work do not. Reaching the threshold admits a bounded snapshot
of waiting observations. That pass drains in existing small batches without
rechecking the count threshold between batches. New intake belongs to the next
pass. Bounded observation keys persist alongside the journal, so admitted work
can resume below the threshold after pause, a budget reset or restart. Application
exclusions and expiry still filter each dispatch; cleared or completed work
cannot be revived by pass metadata.

A pass also starts early when eligible retained evidence reaches 80 percent of
either queue limit (2 MiB or 256 items), or eligible intake shares a queue at that watermark
with blocked evidence. Only eligible observations enter the pass. This prevents
large or blocked observations from making a count threshold unreachable.
The watermark is an admission trigger, not extra budget
or storage: closed hours, pausing and exhausted resources can still defer work,
and existing capacity and retention rules continue to apply. Blocked evidence
alone cannot trigger a review. No polling or enlarged model payload is added.

Without an admitted pass or a reached trigger there is no observation-review timer. Intake, changes to
application rules and settings, and restart reevaluate eligibility. Hours,
pause, resource budgets, concurrency and retention continue to apply. Count
mode does not alter proactive checks or due knowledge reassessments; queued
observations below the threshold do not block those independent activities.

Deferred batch failures wait at least the configured review interval before
retrying; known daily-budget failures wait for their reset. A parallel success
does not clear this deferral. Successful count-mode batches otherwise continue
immediately, subject to the existing processing hours and resource limits.

Proactive explanations are optional model metadata: null, omitted, empty or
non-string reasons receive a neutral runtime label; long reasons are bounded.
Source identities, versions, message validity and time constraints remain
strict, including when loading persisted decisions. This adds no repair call.
Existing failed-attempt receipts keep their retry protection.

## Diagnostics

Use `batchId` or `requestId: learning:<batchId>` to correlate existing model
admission/provider events with these debug events:

1. `review.context_prepared`: context preparation duration and counts.
2. `review.prepared`: contract, selected profile, mode and input/schema sizes.
3. `review.output_accepted` or `review.output_rejected`: fixed action counts or
   a safe rejection code, validation stage and decision index where available.
4. `learning.apply_completed` or `learning.apply_failed` in
   `runtime.long_term_memory`: validation/admission/binding/embedding/commit
   timings, result counts and receipt reuse. A failed stage is not a commit.
5. Existing `batch.completed`, `batch.failed` or `batch.journal_failed`: journal
   outcome. `review.failed` identifies the failing handoff for activity reviews.

Events contain no screen content, memory content, raw model output, arbitrary
property names or exception bodies. They use the existing debug logger and its
rotation/enable controls, with a bounded number of events per review and none
while idle. No timer, separate log store or model call is added. Saved failures
from older runs keep their original reason; a new review produces new diagnostics.
Proactive decoding emits `proactive.output_accepted` or `proactive.output_rejected`
with fixed reason metadata and counts, never raw output. Technical details in
the UI pairs each safe status key with its explanation, including coverage limits.
`processing.pass_admitted` reports the bounded observation count and whether
the trigger was count or storage pressure. It contains no observation identities
or screen content and is emitted only once per newly admitted pass.

## Application controls

The Applications tab derives metadata from retained observations and configured
rules, without a new activity store or model call. Counts cover retained data;
the projection includes at most 100 recent unruled applications plus all rules.
Collection exclusions and processing exclusions are independent, exact
case-insensitive application identities. Browser domains are not inferred.

Processing exclusions retain pending observations under existing expiry and
capacity limits. Pending counters show only eligible observations; blocked
evidence remains explicitly deletable. Mixed pending batches are partitioned durably only after
checking their canonical receipt. Affected active reviews are cancelled before
the new rule is saved; previously sent content cannot be retracted and committed
knowledge is not deleted. Blocked-only queues do not arm a processing timer or
consume model/embedding calls. Re-enabling processing admits retained evidence
through the usual cadence and budget. Old installations default to no processing
exclusions; collection rules continue to use the existing Companion protocol.

Current and legacy memory receipts are reconciled on restart or processing resume,
before cycle admission, budgets or application exclusions. Paused collection can
still start without an available memory store. Reconciliation performs no model
or embedding call and adds no polling timer.
