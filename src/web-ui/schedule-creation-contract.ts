import type { CreateSchedulerJobInput } from "../runtime/scheduler/contracts.js";

export type CreateWebScheduleJobInput =
  | (CreateSchedulerJobInput & { newConversation?: false })
  | (Omit<CreateSchedulerJobInput, "sessionId"> & {
      newConversation: true;
      sessionId?: never;
    });
