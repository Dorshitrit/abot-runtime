import type { StagedReviewCall } from "./staged-review-call.js";
import type { LearningReviewDraft } from "./staged-learning-authoring.js";
import { createLearningStageFormat, decodeLearningStageRows, learningStageMessages, learningStageObject } from "./staged-learning-stage.js";

type TimingRow = Readonly<{ ref: string; reconsiderAfterMinutes: number | null }>;

export async function scheduleLearningChanges(drafts: readonly LearningReviewDraft[], call: StagedReviewCall) {
  const writes = drafts.filter(draft => draft.content !== undefined);
  if (!writes.length) return new Map<string, string | null>();
  const refs = writes.map(draft => draft.ref);
  const format = createLearningStageFormat("timing", [learningStageObject({
    ref: { type: "string", enum: refs },
    reconsiderAfterMinutes: { type: ["integer", "null"], minimum: 1, maximum: 100_000_000 },
  })], writes.length);
  return call("timing", {
    modelStep: "learning.batch", contextRetention: "exact", timeoutReason: "learning_batch_timeout", format,
    messages: learningStageMessages("For each draft choose when its validity should be reviewed again, in minutes from now. Use null for stable knowledge with no justified future deadline. Scheduling is not reinforcement and a passing date does not prove an event happened. Do not rewrite or score the draft.", { drafts: writes }),
    accept(text, diagnostics) {
      const rows = decodeLearningStageRows<TimingRow>(text, format, writes.length, refs);
      return new Map(rows.map(row => [row.ref, row.reconsiderAfterMinutes === null ? null :
        new Date(Date.parse(diagnostics.acceptedAt) + row.reconsiderAfterMinutes * 60_000).toISOString()]));
    },
  }, deadlines => [...deadlines.values()].every(deadline => deadline === null || Date.parse(deadline) > Date.now()));
}
