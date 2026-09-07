import type {
  SchedulerSchedule,
} from "../../../../runtime/scheduler/contracts.js";
import type { CreateWebScheduleJobInput } from "../../../schedule-creation-contract.js";

export declare function scheduleFormInput(
  data: FormData,
  originalSchedule?: SchedulerSchedule,
): CreateWebScheduleJobInput;
export declare function scheduleUpdateInput(
  current: Record<string, unknown>,
  initial: Record<string, unknown>,
): Record<string, unknown>;
