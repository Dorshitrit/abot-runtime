import { computerAccessWidgetSummary } from "./home-widget-summary.js";
import { hostSetupIsReady } from "./rendering.js";

/** A connection badge never implies that either process has macOS permission grants. */
export function computerConnectionCardSummary(state, supported) {
  const summary = computerAccessWidgetSummary(state, supported);
  const identity = state.snapshot?.identity;
  const os = { macos: "macOS", windows: "Windows", linux: "Linux" }[identity?.os] || identity?.os;
  const identityText = [identity?.name, os, identity?.user].filter(Boolean).join(" · ");
  const attention = summary.tone === "attention";
  const connected = supported && !state.statusUnavailable && !state.busy && hostSetupIsReady(state.snapshot);
  const status = connected && attention ? "Needs attention" : summary.status;
  let detail = summary.detail || summary.title;
  if (connected && !attention && identityText) detail = identityText;
  let tone = summary.tone;
  if (connected && !attention) tone = "success";
  return { detail, status, tone, actionLabel: "Manage" };
}
