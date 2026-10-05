import type {
  SchedulerAutomationExecutor,
  SchedulerExecutor,
} from "../scheduler/contracts.js";
import type { SessionRequestAdmission } from "../request/session-admission.js";

/** Keep request and automation admission distinct under the same owner. */
export function createSchedulerExecutorDispatch(options: {
  request: SchedulerExecutor;
  automation?: Omit<SchedulerAutomationExecutor, "tryReserve">;
  admission: SessionRequestAdmission;
}): {
  executor: SchedulerExecutor;
  automationExecutor?: SchedulerAutomationExecutor;
} {
  const automationExecutor = options.automation
    ? {
        ...options.automation,
        tryReserve: (automationId: string) =>
          options.admission.tryReserveAutomation(automationId),
      }
    : undefined;
  return { executor: options.request, automationExecutor };
}
