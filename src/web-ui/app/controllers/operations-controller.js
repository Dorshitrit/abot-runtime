import { escapeHtml, formatTime, shortId, textOf } from "../lib/text-format.js";
import { getNumber } from "../lib/event-presentation.js";

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
    (left, right) =>
      getNumber(right.lastEventAt, 0) - getNumber(left.lastEventAt, 0),
  )[0];
}

export function createOperationsController({ dom, client }) {
  return {
    async loadRuntimeStatus() {
      dom.runtimeStatus.textContent = "Loading...";
      try {
        const payload = await client.getRuntimeStatus();
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
      } catch (error) {
        dom.runtimeStatus.innerHTML = `<span class="error-text">${escapeHtml(
          error instanceof Error ? error.message : String(error),
        )}</span>`;
      }
    },

    async loadRuntimeLogs() {
      dom.runtimeLogs.textContent = "Loading...";
      try {
        const payload = await client.getRuntimeLogs(100);
        const lines = Array.isArray(payload.log?.lines)
          ? payload.log.lines
          : [];
        dom.runtimeLogs.textContent = lines.length
          ? lines.join("\n")
          : "No runtime log lines returned.";
      } catch (error) {
        dom.runtimeLogs.textContent =
          error instanceof Error ? error.message : String(error);
      }
    },

    async loadSystemHealth() {
      dom.healthStatus.textContent = "Loading...";
      try {
        const payload = await client.getSystemHealth();
        const details = Array.isArray(payload.activeStreamingRequestDetails)
          ? payload.activeStreamingRequestDetails
          : [];
        const latest = latestHealthEvent(details);
        const rows = [
          ["Status", payload.ok ? "Healthy" : "Unhealthy"],
          ["Runtime mode", payload.agentMode || "-"],
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
      } catch (error) {
        dom.healthStatus.innerHTML = `<span class="error-text">${escapeHtml(
          error instanceof Error ? error.message : String(error),
        )}</span>`;
      }
    },
  };
}
