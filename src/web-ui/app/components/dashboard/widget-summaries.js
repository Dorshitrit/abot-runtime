import {
  dashboardTimePresentation,
  projectDashboardActivity,
  projectDashboardConversations,
} from "../../lib/dashboard-presentation.js";
import { coWorkerAgentState } from "../passive-learning/agent-state.js";
import { learningWidgetPreview } from "../passive-learning/home-widget-preview.js";
import { formatToolName } from "../../lib/event-presentation.js";
import { projectToolActivityEvent } from "../../lib/tool-activity-event.js";
import { textOf } from "../../lib/text-format.js";

function learningSnapshotMatchesEnvironment(snapshot, learning) {
  if (!snapshot.environmentId || !learning?.environmentId) return true;
  return snapshot.environmentId === learning.environmentId;
}

function learningSummary(snapshot, learning) {
  const current = learningSnapshotMatchesEnvironment(snapshot, learning) ? learning : null;
  if (current?.statusError)
    return { title: "Connection interrupted", detail: "Open Spark to check its current activity.", status: "Status unavailable", tone: "attention" };
  const presentation = coWorkerAgentState(current || {});
  const tones = { attention: "attention", collecting: "active", reviewing: "active" };
  return {
    title: presentation.title,
    detail: presentation.description,
    status: presentation.label,
    tone: tones[presentation.mode] || "neutral",
    preview: learningWidgetPreview(current?.status),
  };
}

function conversationsSummary(snapshot) {
  const overview = snapshot.sessionOverview;
  const projection = projectDashboardConversations(overview?.sessions ?? snapshot.sessions ?? [], 2);
  const latest = projection.recentConversations[0];
  const title = latest?.title || "A fresh start.";
  if (snapshot.sessionsError)
    return { title: latest?.title || "Conversations unavailable", detail: "Recent conversations could not be refreshed.", status: "Status unavailable", tone: "attention" };
  if (snapshot.loadingSessions)
    return { title: latest?.title || "Loading conversations…", detail: "", status: "Loading", tone: "neutral" };
  const unavailable = overview?.hasUnavailableReadState ?? projection.hasUnavailableReadState;
  if (unavailable)
    return { title, detail: "Unread status unavailable", status: "Open chats", tone: "attention" };
  const unread = overview?.unreadCount ?? projection.unreadCount;
  const preview = conversationsPreview(projection, unread);
  if (unread > 0)
    return { title, detail: latest ? "Latest conversation" : "Open chats to read replies.", status: `${unread} unread ${unread === 1 ? "message" : "messages"}`, tone: "active", preview };
  return { title, detail: latest ? "Latest conversation" : "Your conversations will appear here.", status: latest ? "No unread messages" : "No conversations yet", tone: "neutral", preview };
}

function activitySummary(snapshot) {
  if (snapshot.supportsSchedules === false)
    return { title: "Jobs unavailable", detail: "Choose a Runtime environment to use scheduled jobs.", status: "Unavailable", tone: "neutral" };
  const latest = projectDashboardActivity(snapshot.runs ?? [], 1)[0];
  if (snapshot.activityError)
    return { title: latest?.title || "Activity unavailable", detail: "Recent activity could not be refreshed.", status: "Status unavailable", tone: "attention" };
  if (snapshot.loadingActivity)
    return { title: latest?.title || "Loading activity…", detail: "", status: "Loading", tone: "neutral" };
  if (!latest)
    return { title: "No activity yet", detail: "Try a ready-to-use job.", status: "View jobs", tone: "neutral" };
  return { title: latest.title, detail: "Latest scheduled run", status: latest.statusLabel, tone: latest.tone, preview: activityPreview(snapshot.runs) };
}

function automationsSummary(snapshot) {
  const active = snapshot.activeAutomations ?? [];
  if (snapshot.automationStatusUnavailable)
    return { title: "Automation status unavailable", detail: active[0]?.title || "Open ABot Studio to check runs.", status: active.length ? `${active.length} last seen in progress` : "Status unavailable", tone: "attention" };
  if (!active.length)
    return { title: "No automations in progress", detail: "ABot Studio", status: "No active runs", tone: "neutral" };
  return {
    title: `${active.length} ${active.length === 1 ? "automation" : "automations"} in progress`,
    detail: active[0].title || "ABot Automation",
    status: "View live timeline",
    tone: "active",
    preview: {
      kind: "automation", title: active[0].title || "ABot Automation", detail: "ABot Studio",
      indicator: { icon: "active", label: `${active.length} ${active.length === 1 ? "automation" : "automations"} in progress`, value: active.length, tone: "active" },
    },
  };
}

function approvalsSummary(snapshot) {
  if (snapshot.supportsToolApprovals === false)
    return { title: "Home approvals unavailable", detail: "Open the conversation to review pending actions.", status: "Unavailable", tone: "neutral" };
  const count = snapshot.approvals?.length || 0;
  const pendingTitle = `${count} ${count === 1 ? "action" : "actions"} waiting`;
  if (snapshot.approvalDecisionError)
    return { title: count ? pendingTitle : "Approval decision failed", detail: "Open approvals to review the failed decision.", status: "Needs attention", tone: "attention" };
  if (snapshot.approvalsError)
    return { title: count ? pendingTitle : "Approvals unavailable", detail: "Pending actions could not be refreshed.", status: "Status unavailable", tone: "attention" };
  if (snapshot.loadingApprovals)
    return { title: count ? pendingTitle : "Checking approvals…", detail: "", status: "Loading", tone: "neutral" };
  if (count)
    return { title: pendingTitle, detail: "Review the action before allowing it.", status: "Needs review", tone: "attention", preview: approvalsPreview(snapshot) };
  return { title: "No pending approvals", detail: "Actions waiting for your decision appear here.", status: "Nothing waiting", tone: "neutral" };
}

function conversationIndicator(session) {
  if (session.readStateUnavailable)
    return { icon: "unknown", label: "Unread status unavailable", tone: "attention" };
  if (!session.unreadCount) return null;
  return { icon: "unread", label: `${session.unreadCount} unread ${session.unreadCount === 1 ? "message" : "messages"}`, value: session.unreadCount, tone: "active" };
}

function conversationsPreview(projection, unread) {
  if (!projection.recentConversations.length) return undefined;
  return {
    kind: "rows",
    badge: unread > 0 ? { icon: "unread", label: `${unread} unread ${unread === 1 ? "message" : "messages"} in all conversations`, value: unread, tone: "active" } : undefined,
    items: projection.recentConversations.map((session) => ({
      title: session.title,
      detail: dashboardTimePresentation(session.updatedAt)?.label || "",
      indicator: conversationIndicator(session),
    })),
  };
}

function activityPreview(runs) {
  return {
    kind: "rows",
    items: projectDashboardActivity(runs, 2).map((run) => ({
      title: run.title,
      detail: dashboardTimePresentation(run.timestamp)?.label || "",
      indicator: { icon: run.tone, label: run.statusLabel, tone: run.tone },
    })),
  };
}

function approvalsPreview(snapshot) {
  return {
    kind: "rows",
    badge: { value: snapshot.approvals.length, label: `${snapshot.approvals.length} pending ${snapshot.approvals.length === 1 ? "approval" : "approvals"}`, tone: "attention" },
    items: snapshot.approvals.slice(0, 2).map((approval) => {
      const event = approval.event || {};
      const activity = projectToolActivityEvent(event);
      const conversation = (snapshot.sessions || []).find((session) => session.id === approval.sessionId);
      return {
        title: formatToolName(event.tool) || "Tool",
        detail: activity?.target || textOf(conversation?.displayName || conversation?.title),
        indicator: { icon: "active", label: "Awaiting approval", tone: "attention" },
      };
    }),
  };
}

/** Read-only presentation of the existing Home owners; no new reads or state. */
export function dashboardWidgetSummaries(snapshot = {}, learningSnapshot) {
  return {
    learning: learningSummary(snapshot, learningSnapshot),
    conversations: conversationsSummary(snapshot),
    activity: activitySummary(snapshot),
    automations: automationsSummary(snapshot),
    approvals: approvalsSummary(snapshot),
  };
}
