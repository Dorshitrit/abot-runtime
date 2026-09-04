import { isNearScrollEnd, pinScrollToEnd } from "../ui-behavior.js";
import { applyTextDirection, renderMarkdown } from "../lib/text-format.js";
import { createConversationActivity } from "./conversation-activity.js";
import { createComposerPlan } from "./composer-plan.js";
import { buildComposerPlanModel } from "../lib/composer-plan-model.js";
import {
  buildComposerContextWindowModel,
  createComposerContextWindow,
} from "./composer-context-window.js";
import { createMessageAttachments } from "./message-attachments.js";
import { createMessageTimestamp } from "./message-timestamp.js";

export function createConversationView({
  dom,
  getMessages,
  getActiveRequestId = () => "",
  getActivityForMessage,
  getPendingApproval,
  createApprovalCard,
  copyText,
  notify,
  resolveAttachmentUrl = () => "",
  documentRoot = document,
  viewport = window,
}) {
  const conversationActivity = createConversationActivity({ documentRoot });
  const composerContextWindow = createComposerContextWindow({
    container: dom.composerContextWindow,
    documentRoot,
  });
  const composerPlan = createComposerPlan({
    container: dom.composerPlan,
    documentRoot,
  });
  const messageAttachments = createMessageAttachments({
    documentRoot,
    resolveAttachmentUrl,
  });
  const viewState = {
    followMessages: true,
    collapsedThinkingMessageIds: new Set(),
    messageRenderTimer: 0,
    thinkingRenderTimer: 0,
    scrollSettleVersion: 0,
    bound: false,
  };

  function updateJumpToLatest() {
    const hasOverflow =
      dom.messagesList.scrollHeight > dom.messagesList.clientHeight + 24;
    dom.jumpToLatestButton.hidden = viewState.followMessages || !hasOverflow;
  }

  function scrollToEnd() {
    viewState.followMessages = true;
    pinScrollToEnd(dom.messagesList);
    updateJumpToLatest();
    const settleVersion = ++viewState.scrollSettleVersion;
    viewport.requestAnimationFrame(() => {
      if (
        !viewState.followMessages ||
        settleVersion !== viewState.scrollSettleVersion
      ) {
        return;
      }
      pinScrollToEnd(dom.messagesList);
      viewport.requestAnimationFrame(() => {
        if (
          !viewState.followMessages ||
          settleVersion !== viewState.scrollSettleVersion
        ) {
          return;
        }
        pinScrollToEnd(dom.messagesList);
        updateJumpToLatest();
      });
    });
  }

  function renderEmptyState() {
    dom.messagesList.innerHTML = `
      <div class="empty-state chat-empty-state">
        <div class="mode-empty-title">What would you like to work on?</div>
        <div class="mode-empty-copy">Ask a question, inspect a project, or start a task.</div>
      </div>
    `;
  }

  function createMessageNode(message) {
    const row = documentRoot.createElement("article");
    row.className = `message-row ${message.role === "user" ? "user" : "assistant"}`;
    row.setAttribute(
      "aria-label",
      message.role === "user" ? "Your message" : "ABot response",
    );
    if (message.role !== "user") {
      const avatar = documentRoot.createElement("div");
      avatar.className = "message-avatar";
      avatar.setAttribute("aria-hidden", "true");
      avatar.textContent = "A";
      row.appendChild(avatar);
    }

    const bubble = documentRoot.createElement("div");
    bubble.className = "message-bubble";
    if (message.requestId) bubble.title = `Request ${message.requestId}`;

    const meta = documentRoot.createElement("div");
    meta.className = "message-meta";
    const author = documentRoot.createElement("span");
    author.textContent = message.role === "user" ? "You" : "ABot";
    meta.appendChild(author);
    const timestamp = createMessageTimestamp({
      documentRoot,
      value: message.createdAt,
    });
    if (timestamp) meta.appendChild(timestamp);
    if (message.streaming) {
      const streaming = documentRoot.createElement("span");
      streaming.className = "streaming-status";
      streaming.textContent = "Responding";
      meta.appendChild(streaming);
    }

    const body = documentRoot.createElement("div");
    body.className = "markdown-body";
    applyTextDirection(body, message.text);
    body.innerHTML = message.text
      ? renderMarkdown(message.text)
      : message.streaming
        ? '<span class="typing-indicator" aria-label="ABot is working"><i></i><i></i><i></i></span>'
        : "";

    bubble.appendChild(meta);
    const attachments = messageAttachments.createNode(message.attachments);
    if (attachments) bubble.appendChild(attachments);

    if (message.role !== "user" && message.requestId) {
      const activityInput = {
        requestId: message.requestId,
        streaming: Boolean(message.streaming),
        ...getActivityForMessage(message),
      };
      const activity = conversationActivity.createNode(activityInput);
      if (activity) bubble.appendChild(activity);
    }

    if (message.thinkingText) {
      const thinking = documentRoot.createElement("details");
      thinking.className = "thinking-card";
      thinking.open =
        Boolean(message.streaming) &&
        !viewState.collapsedThinkingMessageIds.has(message.id);
      thinking.addEventListener("toggle", () => {
        if (!message.streaming) return;
        if (thinking.open) {
          viewState.collapsedThinkingMessageIds.delete(message.id);
        } else {
          viewState.collapsedThinkingMessageIds.add(message.id);
        }
      });
      const summary = documentRoot.createElement("summary");
      summary.innerHTML = `<span>Reasoning</span><span>${
        message.streaming ? "Live" : "View"
      }</span>`;
      const thinkingBody = documentRoot.createElement("div");
      thinkingBody.className = "thinking-body";
      applyTextDirection(thinkingBody, message.thinkingText);
      thinkingBody.innerHTML = renderMarkdown(message.thinkingText);
      thinking.append(summary, thinkingBody);
      bubble.appendChild(thinking);
    }

    bubble.appendChild(body);
    if (message.role !== "user" && message.text && !message.streaming) {
      const actions = documentRoot.createElement("div");
      actions.className = "message-actions";
      const copyButton = documentRoot.createElement("button");
      copyButton.type = "button";
      copyButton.className = "message-action-button";
      copyButton.textContent = "Copy";
      copyButton.setAttribute("aria-label", "Copy response");
      copyButton.addEventListener("click", () => {
        void copyText(message.text)
          .then(() => notify("Response copied"))
          .catch(() => notify("Could not copy response", "failed"));
      });
      actions.appendChild(copyButton);
      bubble.appendChild(actions);
    }
    row.appendChild(bubble);
    return row;
  }

  function renderContextWindow() {
    composerContextWindow.render(
      buildComposerContextWindowModel({
        messages: getMessages(),
        activeRequestId: getActiveRequestId(),
        getActivityForMessage,
      }),
    );
  }

  function render() {
    renderContextWindow();
    composerPlan.render(
      buildComposerPlanModel({
        messages: getMessages(),
        activeRequestId: getActiveRequestId(),
        getActivityForMessage,
      }),
    );
    const previousScrollTop = dom.messagesList.scrollTop;
    const shouldFollow =
      viewState.followMessages || isNearScrollEnd(dom.messagesList);
    const messages = getMessages();
    dom.messagesList.innerHTML = "";
    if (messages.length === 0) {
      renderEmptyState();
      viewState.followMessages = true;
      updateJumpToLatest();
      return;
    }
    for (const message of messages) {
      dom.messagesList.appendChild(createMessageNode(message));
    }
    const pendingApproval = getPendingApproval();
    if (pendingApproval) {
      dom.messagesList.appendChild(createApprovalCard(pendingApproval));
    }
    if (shouldFollow) {
      scrollToEnd();
    } else {
      dom.messagesList.scrollTop = previousScrollTop;
      viewState.followMessages = false;
      updateJumpToLatest();
    }
  }

  function scheduleThinkingRender() {
    if (viewState.thinkingRenderTimer) return;
    viewState.thinkingRenderTimer = viewport.setTimeout(() => {
      viewState.thinkingRenderTimer = 0;
      render();
    }, 180);
  }

  function scheduleMessageRender() {
    if (viewState.messageRenderTimer) return;
    viewState.messageRenderTimer = viewport.setTimeout(() => {
      viewState.messageRenderTimer = 0;
      render();
    }, 72);
  }

  function cancelScheduledMessageRender() {
    if (!viewState.messageRenderTimer) return;
    viewport.clearTimeout(viewState.messageRenderTimer);
    viewState.messageRenderTimer = 0;
  }

  function cancelScheduledThinkingRender() {
    if (!viewState.thinkingRenderTimer) return;
    viewport.clearTimeout(viewState.thinkingRenderTimer);
    viewState.thinkingRenderTimer = 0;
  }

  function reset() {
    viewState.followMessages = true;
    viewState.collapsedThinkingMessageIds.clear();
    viewState.scrollSettleVersion += 1;
    cancelScheduledMessageRender();
    cancelScheduledThinkingRender();
    conversationActivity.reset();
    composerContextWindow.reset();
    composerPlan.reset();
  }

  function forgetThinkingDisclosure(messageId) {
    viewState.collapsedThinkingMessageIds.delete(messageId);
  }

  function bind() {
    if (viewState.bound) return;
    viewState.bound = true;
    dom.jumpToLatestButton.addEventListener("click", scrollToEnd);
    dom.messagesList.addEventListener("scroll", () => {
      viewState.followMessages = isNearScrollEnd(dom.messagesList);
      if (!viewState.followMessages) viewState.scrollSettleVersion += 1;
      updateJumpToLatest();
    });
  }

  return {
    bind,
    cancelScheduledMessageRender,
    cancelScheduledThinkingRender,
    forgetThinkingDisclosure,
    render,
    renderContextWindow,
    reset,
    scheduleMessageRender,
    scheduleThinkingRender,
  };
}
