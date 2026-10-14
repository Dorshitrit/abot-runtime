import { displayReasoningMode } from "../lib/reasoning-controls.js";
import { escapeHtml, formatTime, shortId, textOf } from "../lib/text-format.js";
import { formatDurationMs, latestHealthEvent, projectOperationsSummary } from "../components/operations-summary.js";

export { formatDurationMs, latestHealthEvent } from "../components/operations-summary.js";

function renderRuntimeRows(rows) {
  return `
    <div class="runtime-grid">
      ${rows
        .map(
          ([label, value]) => `
            <div class="runtime-row">
              <span>${escapeHtml(label)}</span>
              <strong dir="auto">${escapeHtml(textOf(value, "-") || "-")}</strong>
            </div>
          `,
        )
        .join("")}
    </div>
  `;
}

export function createOperationsController({ dom, client, getEnvironmentId = () => undefined, onSummaryChange = () => {} }) {
  let statusRevision = 0;
  let logsRevision = 0;
  let healthRevision = 0;
  let displayedEnvironment = getEnvironmentId();
  const reads = { runtime: { phase: "idle" }, logs: { phase: "idle" }, health: { phase: "idle" } };
  function updateSummaryRead(tab, read) {
    reads[tab] = read;
    onSummaryChange();
  }
  function isCurrentOperationsRead(environmentId, revision, currentRevision) {
    if (environmentId !== getEnvironmentId()) return false;
    return revision === currentRevision;
  }
  function isCurrentHealthRead(revision) {
    return revision === healthRevision;
  }
  const controller = {
    summary(tab) {
      return projectOperationsSummary(tab, reads, getEnvironmentId());
    },
    environmentChanged() {
      const environmentId = getEnvironmentId();
      if (displayedEnvironment === environmentId) return;
      displayedEnvironment = environmentId;
      void controller.loadRuntimeStatus();
      void controller.loadRuntimeLogs();
    },
    async loadRuntimeStatus() {
      const environmentId = getEnvironmentId();
      const revision = ++statusRevision;
      dom.runtimeStatus.textContent = "Loading...";
      updateSummaryRead("runtime", { phase: "loading", environmentId });
      try {
        const payload = await client.getRuntimeStatus(environmentId);
        if (!isCurrentOperationsRead(environmentId, revision, statusRevision)) return;
        const status = payload.status || {};
        dom.runtimeStatus.innerHTML = `
          <div class="runtime-grid">
            <div class="runtime-row"><span>Source</span><strong>${escapeHtml(payload.source || "runtime")}</strong></div>
            <div class="runtime-row"><span>PID</span><strong>${escapeHtml(textOf(status.pid, "-"))}</strong></div>
            <div class="runtime-row"><span>Uptime</span><strong>${escapeHtml(status.uptimeMs ? `${Math.round(status.uptimeMs / 1000)}s` : "-")}</strong></div>
            <div class="runtime-row"><span>Node</span><strong>${escapeHtml(status.node?.version || "-")}</strong></div>
            <div class="runtime-row"><span>Trace</span><strong>${escapeHtml(status.config?.traceFile || "-")}</strong></div>
          </div>
        `;
        updateSummaryRead("runtime", { phase: "ready", environmentId, payload });
      } catch (error) {
        if (!isCurrentOperationsRead(environmentId, revision, statusRevision)) return;
        dom.runtimeStatus.innerHTML = `<span class="error-text">${escapeHtml(
          error instanceof Error ? error.message : String(error),
        )}</span>`;
        updateSummaryRead("runtime", { phase: "error", environmentId });
      }
    },

    async loadRuntimeLogs() {
      const environmentId = getEnvironmentId();
      const revision = ++logsRevision;
      dom.runtimeLogs.textContent = "Loading...";
      updateSummaryRead("logs", { phase: "loading", environmentId });
      try {
        const payload = await client.getRuntimeLogs(100, environmentId);
        if (!isCurrentOperationsRead(environmentId, revision, logsRevision)) return;
        const lines = Array.isArray(payload.log?.lines)
          ? payload.log.lines
          : [];
        dom.runtimeLogs.textContent = lines.length
          ? lines.join("\n")
          : "No runtime log lines returned.";
        updateSummaryRead("logs", { phase: "ready", environmentId, payload, refreshedAt: Date.now() });
      } catch (error) {
        if (!isCurrentOperationsRead(environmentId, revision, logsRevision)) return;
        dom.runtimeLogs.textContent =
          error instanceof Error ? error.message : String(error);
        updateSummaryRead("logs", { phase: "error", environmentId });
      }
    },

    async loadSystemHealth() {
      const revision = ++healthRevision;
      dom.healthStatus.textContent = "Loading...";
      updateSummaryRead("health", { phase: "loading" });
      try {
        const payload = await client.getSystemHealth();
        if (!isCurrentHealthRead(revision)) return;
        const details = Array.isArray(payload.activeStreamingRequestDetails)
          ? payload.activeStreamingRequestDetails
          : [];
        const latest = latestHealthEvent(details);
        const rows = [
          ["Status", payload.ok ? "Healthy" : "Unhealthy"],
          ["Runtime mode", displayReasoningMode(payload.agentMode) || "-"],
          ["Active streams", payload.activeStreamingRequests ?? details.length],
          [
            "Latest event",
            latest?.lastEventName || latest?.lastEventType || "-",
          ],
          ["Latest idle", latest ? formatDurationMs(latest.idleMs) : "-"],
        ];
        const activeRequests = details
          .slice(0, 8)
          .map(
            (request) => `
              <div class="health-request">
                <div>
                  <strong>${escapeHtml(shortId(request.requestId))}</strong>
                  <span>${escapeHtml(request.environment || request.agentId || "-")} / ${escapeHtml(
                    request.sessionId ? shortId(request.sessionId) : "-",
                  )}</span>
                </div>
                <div>
                  <span>${escapeHtml(request.lastEventName || request.lastEventType || "-")}</span>
                  <span>${escapeHtml(formatDurationMs(request.idleMs))} idle</span>
                </div>
              </div>
            `,
          )
          .join("");
        dom.healthStatus.innerHTML = `
          <div class="health-topline">
            <span class="health-pill ${payload.ok ? "healthy" : "failed"}">${
              payload.ok ? "OK" : "Issue"
            }</span>
            <span>${escapeHtml(formatTime(Date.now()))}</span>
          </div>
          ${renderRuntimeRows(rows)}
          ${
            activeRequests
              ? `<div class="health-requests">${activeRequests}</div>`
              : '<div class="empty-state compact">No active streaming requests</div>'
          }
        `;
        updateSummaryRead("health", { phase: "ready", payload });
      } catch (error) {
        if (!isCurrentHealthRead(revision)) return;
        dom.healthStatus.innerHTML = `<span class="error-text">${escapeHtml(
          error instanceof Error ? error.message : String(error),
        )}</span>`;
        updateSummaryRead("health", { phase: "error" });
      }
    },
  };
  return controller;
}
