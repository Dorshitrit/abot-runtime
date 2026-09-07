/** Immutable identity of the scheduled request represented by one message. */
export type ScheduleMessageReference = Readonly<{
  jobId: string;
  runId: string;
  title: string;
  scheduledAt: string;
  triggerType: "schedule" | "manual";
}>;
