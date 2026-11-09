import { captureSparkHomeWidgetSlots } from "./spark-home-widget-slots.js";
import { sparkHomeWidgetGeometryScript, sparkHomeWidgetRelayScript } from "./spark-home-widget-bridge.js";

/** The trusted outer document owns navigation policy for the generated inner frame. */
export const SPARK_HOME_CONTENT_POLICY = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data:",
  "font-src data:",
  "connect-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
  "sandbox allow-scripts",
].join("; ");

function escapeSourceDocument(html: string): string {
  return html.replace(/&/g, "&amp;").replace(/"/g, "&quot;")
    .replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** srcdoc inherits CSP; the wrapper prevents network navigation of its child. */
export function renderSparkHomeDocument(html: string, revision?: number): string {
  const captured = revision === undefined ? { html, slots: [], firstSlotOffset: null } : captureSparkHomeWidgetSlots(html);
  const bridgeOffset = captured.firstSlotOffset;
  const hasWidgets = bridgeOffset !== null && revision !== undefined;
  const source = hasWidgets ? captured.html.slice(0, bridgeOffset)
    + sparkHomeWidgetGeometryScript(revision, captured.slots) + captured.html.slice(bridgeOffset) : html;
  const relay = hasWidgets ? sparkHomeWidgetRelayScript(revision, captured.slots) : "";
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SPARK HOME</title>
<style>html,body{height:100%;margin:0;background:transparent}iframe{display:block;width:100%;height:100%;border:0}</style>
${relay}</head><body><iframe title="SPARK HOME canvas" sandbox="allow-scripts" referrerpolicy="no-referrer" srcdoc="${escapeSourceDocument(source)}"></iframe></body></html>`;
}

/** Only the host-owned outer frame reports failure; generated inner content cannot impersonate it. */
export function renderSparkHomeLoadFailure(revision: number | null): string {
  const message = JSON.stringify({ kind: "abot.spark-home-load-error", revision,
    error: "spark_home_content_unavailable" });
  return `<!doctype html><html><head><meta charset="utf-8"><title>SPARK HOME unavailable</title>
<style>body{font:14px system-ui;padding:24px;color:#666}</style></head><body>
<p>This screen could not be loaded. Use Try loading again above.</p>
<script>parent.postMessage(${message}, "*");</script></body></html>`;
}
