import { automationNotificationIdentity } from "./identity.js";
import type { WebNotification } from "./contracts.js";
import { eventText, hasNotificationIdentity, notificationBody } from "./event-fields.js";

type AutomationRunStatus =
  | "succeeded" | "completed_with_skips" | "failed"
  | "cancelled" | "interrupted" | "missed";

const TERMINAL_TITLES: Record<AutomationRunStatus, string> = {
  succeeded: "Automation completed",
  completed_with_skips: "Automation completed with skipped steps",
  failed: "Automation failed",
  cancelled: "Automation stopped",
  interrupted: "Automation interrupted",
  missed: "Automation run missed",
};

function terminalAutomationStatus(value: string): value is AutomationRunStatus {
  return Object.hasOwn(TERMINAL_TITLES, value);
}

function automationNotificationPhase(name: unknown): "started" | "finished" | null {
  if (name === "automation.run.started") return "started";
  if (name === "automation.run.finished") return "finished";
  return null;
}

/** A committed scheduler transition points to its canonical run report. */
export function projectAutomationRunNotificationEvent(
  event: Record<string, unknown>,
  now: number,
): WebNotification | undefined {
  if (event.type !== "event") return;
  const phase = automationNotificationPhase(event.name);
  if (!phase) return;
  const status = eventText(event.status);
  if (phase === "started" && status !== "running") return;
  if (phase === "finished" && !terminalAutomationStatus(status)) return;
  const environmentId = eventText(event.environment) || eventText(event.environmentId);
  const automationId = eventText(event.automationId);
  const runId = eventText(event.runId);
  if (![environmentId, automationId, runId].every(hasNotificationIdentity)) return;
  const name = notificationBody(eventText(event.title)) || "Automation";
  const title = phase === "started" ? "Automation started" : TERMINAL_TITLES[status as AutomationRunStatus];
  const parameters = new URLSearchParams({ environment: environmentId, automation: automationId, run: runId });
  const id = automationNotificationIdentity(environmentId, runId, phase);
  return {
    id,
    kind: "automation",
    title,
    body: name,
    createdAt: now,
    readAt: null,
    environmentId,
    automationId,
    runId,
    sourceUrl: `/automations?${parameters}`,
    delivery: { status: "pending" },
  };
}
