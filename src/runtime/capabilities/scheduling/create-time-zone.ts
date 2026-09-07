export function requireCreateCalendarTimeZone(
  params: Record<string, unknown>,
): void {
  const isCalendarSchedule = ["daily", "weekly", "monthly"].includes(
    String(params.scheduleKind),
  );
  if (!isCalendarSchedule) return;
  if (typeof params.timeZone !== "string") {
    throw new Error("schedule_time_zone_required");
  }
  if (!params.timeZone.trim()) {
    throw new Error("schedule_time_zone_required");
  }
}
