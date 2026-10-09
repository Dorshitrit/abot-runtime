import { formatTime, textOf } from "../lib/text-format.js";
import { getNumber } from "../lib/event-presentation.js";

export function formatDurationMs(value) {
  const ms = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(ms) || ms < 0) return "-";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

export function latestHealthEvent(details) {
  return [...details].sort(
    (left, right) => getNumber(right.lastEventAt, 0) - getNumber(left.lastEventAt, 0),
  )[0];
}

function unavailableReadValue(read, environmentId, environmentScoped) {
  if (environmentScoped && read.environmentId !== environmentId) return "Not loaded";
  if (read.phase === "loading") return "Loading…";
  if (read.phase === "error") return "Unavailable";
  if (read.phase !== "ready") return "Not loaded";
  return null;
}

function environmentValue(environmentId, source) {
  const environment = textOf(environmentId) || "Current environment";
  if (typeof source !== "string" || !source) return environment;
  return `${environment} · ${source}`;
}

function runtimeSummary(read, environmentId) {
  const unavailable = unavailableReadValue(read, environmentId, true);
  const payload = unavailable ? {} : read.payload;
  const status = payload.status || {};
  const uptime = typeof status.uptimeMs === "number" ? formatDurationMs(status.uptimeMs) : "-";
  return {
    label: "Runtime · selected environment",
    items: [
      { label: "Environment", value: environmentValue(environmentId, payload.source) },
      { label: "Uptime", value: unavailable || uptime, status: Boolean(unavailable) },
      { label: "PID", value: unavailable || textOf(status.pid, "-") || "-" },
      { label: "Node", value: unavailable || textOf(status.node?.version, "-") || "-" },
    ],
  };
}

function logFileAvailability(exists) {
  if (exists === true) return "Available";
  if (exists === false) return "Missing";
  return "-";
}

function logsSummary(read, environmentId) {
  const unavailable = unavailableReadValue(read, environmentId, true);
  const log = unavailable ? {} : read.payload.log || {};
  return {
    label: "Logs · selected environment",
    items: [
      { label: "Environment", value: environmentValue(environmentId) },
      { label: "Lines shown", value: unavailable || (Array.isArray(log.lines) ? String(log.lines.length) : "-"), status: Boolean(unavailable) },
      { label: "Last refreshed", value: unavailable || formatTime(read.refreshedAt) || "-" },
      { label: "Log file", value: unavailable || logFileAvailability(log.exists) },
    ],
  };
}

function healthValue(ok) {
  if (ok === true) return "Healthy";
  if (ok === false) return "Unhealthy";
  return "-";
}

function activeStreamCount(payload) {
  const count = payload.activeStreamingRequests;
  if (typeof count === "number" && Number.isFinite(count) && count >= 0) return String(count);
  if (Array.isArray(payload.activeStreamingRequestDetails)) return String(payload.activeStreamingRequestDetails.length);
  return "-";
}

function healthSummary(read) {
  const unavailable = unavailableReadValue(read, undefined, false);
  const payload = unavailable ? {} : read.payload;
  const details = Array.isArray(payload.activeStreamingRequestDetails) ? payload.activeStreamingRequestDetails : [];
  const latest = latestHealthEvent(details);
  return {
    label: "System health · all environments",
    items: [
      { label: "Health · all environments", value: unavailable || healthValue(payload.ok), status: true },
      { label: "Runtime mode", value: unavailable || textOf(payload.agentMode, "-") || "-" },
      { label: "Active streams", value: unavailable || activeStreamCount(payload) },
      { label: "Latest event", value: unavailable || textOf(latest?.lastEventName || latest?.lastEventType, "-") || "-" },
    ],
  };
}

export function projectOperationsSummary(tab, reads, environmentId) {
  if (tab === "health") return healthSummary(reads.health);
  if (tab === "logs") return logsSummary(reads.logs, environmentId);
  return runtimeSummary(reads.runtime, environmentId);
}
