import type { RuntimeAttachmentStore } from "../attachments/store.js";
import type {
  PreparedAutomationOccurrence,
  SchedulerAutomationJob,
  SchedulerAutomationRun,
} from "../scheduler/contracts.js";
import type { AutomationPersistence } from "./persistence.js";
import type { AutomationJournalState } from "./storage-records.js";

type RetainedInput = Readonly<{
  id: string;
  contentVersion: string;
  storageRef: string;
}>;

function requireRetainedInput(
  state: AutomationJournalState,
  inputId: string,
): RetainedInput {
  const record = state.inputs.find((item) => item.id === inputId);
  if (!record?.snapshot || record.snapshotRetiredAt || record.eligibility === "baseline" ||
      record.snapshot.contentVersion !== record.contentVersion)
    throw new Error("automation_replay_input_unavailable");
  return {
    id: record.id,
    contentVersion: record.contentVersion,
    storageRef: record.snapshot.attachment.storageRef,
  };
}

export function createAutomationReplayPreparer(options: {
  persistence: AutomationPersistence;
  attachments: RuntimeAttachmentStore;
}) {
  return async (
    job: SchedulerAutomationJob,
    previous: SchedulerAutomationRun,
    _candidateRunId: string,
  ): Promise<PreparedAutomationOccurrence> => {
    const state = await options.persistence.read();
    const definition = state.definitions.find((item) =>
      item.automationId === previous.target.automationId &&
      item.revision === previous.target.definitionRevision)?.definition;
    if (!definition) throw new Error("automation_definition_not_found");
    const prior = state.executions.find((item) => item.id === previous.id);
    if (!prior || prior.automationId !== previous.target.automationId ||
        prior.definitionRevision !== previous.target.definitionRevision)
      throw new Error("automation_replay_input_unavailable");
    const inputIds = [...prior.inputIds];
    if (definition.source && inputIds.length === 0)
      throw new Error("automation_replay_input_unavailable");
    const retained = inputIds.map((id) => requireRetainedInput(state, id));
    for (const input of retained) {
      const record = state.inputs.find((item) => item.id === input.id)!;
      await options.attachments.resolveAttachment(record.snapshot!.attachment);
    }
    return {
      kind: "ready",
      inputIds,
      commit: (current, runId) => {
        const liveDefinition = current.definitions.find((item) =>
          item.automationId === previous.target.automationId &&
          item.revision === previous.target.definitionRevision);
        const livePrior = current.executions.find((item) => item.id === previous.id);
        if (!liveDefinition || !livePrior ||
            livePrior.inputIds.length !== inputIds.length ||
            livePrior.inputIds.some((id, index) => id !== inputIds[index]))
          throw new Error("automation_replay_input_changed");
        for (const input of retained) {
          const live = requireRetainedInput(current, input.id);
          if (live.contentVersion !== input.contentVersion ||
              live.storageRef !== input.storageRef)
            throw new Error("automation_replay_input_changed");
        }
        current.executions.push({
          id: runId,
          automationId: job.target.automationId,
          definitionRevision: previous.target.definitionRevision,
          revision: 1,
          inputIds,
          nodes: [],
        });
      },
    };
  };
}
