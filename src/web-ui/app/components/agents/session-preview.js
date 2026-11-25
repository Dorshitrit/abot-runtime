import { escapeHtml as html, renderMarkdown } from "../../lib/text-format.js";

const requestLabels = {
  streaming: "Working",
  awaiting_approval: "Awaiting approval",
  completed: "Completed",
  failed: "Failed",
};

const emptyRequestMessages = {
  streaming: "The session is working. Its reply will appear here.",
  awaiting_approval: "The session is waiting for approval.",
  completed: "The session finished without a visible message.",
  failed: "The request failed before a message was saved.",
};

export function renderAgentSessionPreview({ session, label, status, loading, error }) {
  const request = session?.requests.at(-1);
  const state = request?.status;
  const title = (label || session?.title || "Work session").replace(/\s+/g, " ").trim();
  const heading = title.length > 48 ? title.slice(0, 47).trimEnd() + "…" : title;
  const subtitle = requestLabels[state] || status;
  const messages = (session?.messages || []).filter((message) => message.text.trim());
  const transcript = messages.map((message) => `<article class="agents-message">
    <span class="agents-message-author">${message.role === "user" ? "Work request" : "Session reply"}</span>
    <div class="markdown-body" dir="auto">${renderMarkdown(message.text)}</div>
  </article>`).join("");

  let notice = "";
  if (error) notice = error;
  else if (loading && !session) notice = "Loading session history…";
  else if (!session) notice = "Session history is unavailable.";
  else if (!messages.length) notice = emptyRequestMessages[state] || "No messages have been saved in this session yet.";

  return `<header>
    <div class="agents-session-heading"><strong dir="auto">${html(heading)}</strong>${subtitle ? `<small>${html(subtitle)}</small>` : ""}</div>
    <button type="button" class="agents-close" data-agents-action="close-session" aria-label="Close work session">×</button>
  </header><div class="agents-session-transcript">${notice ? `<p class="agents-session-notice" role="${error ? "alert" : "status"}" dir="auto">${html(notice)}</p>` : ""}${transcript}</div>`;
}
