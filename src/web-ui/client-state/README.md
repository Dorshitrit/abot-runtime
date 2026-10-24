# Web UI state and composer ownership

The Web UI stores installation preferences and Send next queues under
`.runtime/web-ui/client-state/state.json`. This applies to browser and desktop
clients on every supported host. It does not change Runtime request execution.

## State owners

- `store.ts` owns the bounded, versioned file and atomic transactions.
  `preferences.ts` validates known preference keys and merges concurrent edits.
  `queue.ts` applies the existing queue ownership rules within that transaction.
- `app/services/workspace-state-storage.js` owns one acknowledged server snapshot
  and pending preference projections. Writes are ordered by preference key or
  queue scope. A failed write stays visible and cannot poison unrelated lanes.
- `app/controllers/environment-transition.js` owns the active environment in a
  window. The shared saved default never navigates another window. Local route
  commitment precedes saving that default and survives a failed preference save.
- `app/controllers/composer-drafts.js` owns editable text, files, upload generation,
  conversation scope and any recovered queue lease together. These drafts live
  only for the current window; they are not a persistent outbox.
- `app/controllers/composer-submission-lifecycle.js` takes the full draft into one
  immutable attempt and owns its result. A new editing draft is independent.
- `app/controllers/composer-feature.js` composes these owners for Chat and SPARK.
  Home uses another surface of the same composition plus conversation activation.
  The DOM is an input and display, not a second draft store.

## Outcomes and timing

An ordinary send captures scope, model and permission mode before the first
await. It does not wait for saving unrelated defaults. Queue-owned sends still
wait for claim, edit and begin acknowledgements before posting their message.

A definite rejection restores the captured text and files to their original
draft without replacing newer input. For a rejected queue POST, the existing
atomic claim operation returns its lease to editing first; no POST is retried.

A lost or ambiguous acknowledgement keeps the attempt paused separately from
new input. Restoring it requires confirmation that the conversation was checked.
Queued messages also require the existing explicit ownership takeover; there is
no time-based expiry. An unknown enqueue is not automatically restored as a new
message, because its queue entry may already have been committed.

An accepted request is displayed immediately. Only queue-owned attempts bind the
remaining queue to that request. The same queue controller retains terminal
notifications arriving during binding and processes them once after its ACK.
A failed bind pauses the remaining queue and does not invalidate acceptance.

Navigation parks ordinary drafts without persistence. A recovered editing lease
must acknowledge its relevant update before navigation; a revision check prevents
committing navigation over newer edits. Reset/Delete acknowledgements remove
obsolete attachment references from the originating editable draft, including
parked drafts, while preserving their text. They do not introduce a new queue
reset policy or silently discard an uncertain submission.

## Clean start and retention

The first opening explains the approved one-time clean start. Browser-only
preferences and queued messages are not imported. Conversations, memories,
configuration and read state remain in their existing stores. Ask is the initial
permission mode; other modes require an explicit selection.

Memory review receipts keep one revision per memory and at most 200 records per
environment. Confirmed memory deletion retires its receipt.

## Evidence

`client-state/*.test.ts` covers real HTTP persistence, conflicts, unknown ACKs,
concurrent windows, queue ownership, retention and platform file replacement.
`composer-lifecycle/*.test.ts` exercises the production composition with complete
drafts, Home activation and a real local HTTP state server. The existing Web UI
tests cover SPARK, navigation, Stop/Steer, onboarding and model context display.

The timing fixture measures click feedback and time to HTTP POST separately; it
is not a model benchmark. Browser startup and Windows storage tests use isolated
installations, not the user's QA data.

Thinking overrides use the `abot-web.reasoningPreferences` preference map, keyed by environment, conversation and model profile. Profile default removes the override; off, server default and a non-negative token budget are explicit choices; a token budget of 0 disables thinking. Each submitted or queued message captures its own profile-bound choice, so later control changes affect later messages. Unsupported saved choices must be cleared explicitly before sending.
