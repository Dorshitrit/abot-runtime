import { createConversationSchedule } from "./conversation-schedule.js";
import { createConversationStatus } from "./conversation-status.js";
import { createConversationReasoning } from "./conversation-reasoning.js";
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
import { createMessageLinkPreviews } from "./message-link-previews.js";
import { projectApprovalContinuations } from "../lib/request-lifecycle-view.js";
import { captureApprovalRejectionFocus } from "./tool-approval-rejection-input.js";

export function createConversationView({
  dom,
  getMessages,
  getActiveRequestId = () => "",
  isConnected = () => true,
  getActivityForMessage,
  getPendingApproval,
  getPendingApprovals = () => [getPendingApproval?.()].filter(Boolean),
  createApprovalCard,
  copyText,
  notify,
  resolveAttachmentUrl = () => "",
  onOpenSchedule = () => {},
  canOpenSchedule = () => true,
  filePreview = { reset() {}, syncScope() {}, setWorkspace() {} },
  sparkActions = { createNode: () => null },
  scrollBehavior = null,
  preserveMessageHistory = false,
  createActivityView = createConversationActivity,
  statusPresentation = (model) => model,
  statusPlacement = "bubble",
  emptyState = { title: "What would you like to work on?", copy: "Ask a question, inspect a project, or start a task." },
  showReasoning = true,
  showContextWindow = true,
  documentRoot = document,
  viewport = window,
}) {
  const conversationSchedule = createConversationSchedule({
    documentRoot,
    onOpenJob: onOpenSchedule,
    canOpenJob: canOpenSchedule,
  });
  const conversationActivity = createActivityView({
    documentRoot,
    onOpenFile: filePreview.open,
    canOpenFile: filePreview.canOpen,
  });
  const conversationReasoning = createConversationReasoning({ documentRoot });
  const conversationStatus = createConversationStatus({
    getActiveRequestId,
    getActivityForMessage,
    isConnected,
    present: statusPresentation,
    documentRoot,
  });
  const composerContextWindow = showContextWindow ? createComposerContextWindow({
    container: dom.composerContextWindow,
    documentRoot,
  }) : { render() {}, reset() {} };
  const composerPlan = createComposerPlan({
    container: dom.composerPlan,
    documentRoot,
  });
  const messageAttachments = createMessageAttachments({
    documentRoot,
    resolveAttachmentUrl,
  });
  const messageLinkPreviews = createMessageLinkPreviews({
    documentRoot,
    viewport,
    scrollRoot: dom.messagesList,
    onLayoutChange: () => {
      if (scrollBehavior) { scrollBehavior.onLayoutChange?.(); return; }
      if (viewState.followMessages) scrollToEnd();
    },
  });
  let historyPager;
  let holdingPosition = false;
  const viewState = {
    followMessages: true,
    messageRenderTimer: 0,
    thinkingRenderTimer: 0,
    scrollSettleVersion: 0,
    bound: false,
  };

  function updateJumpToLatest() {
    const hasOverflow =
      dom.messagesList.scrollHeight > dom.messagesList.clientHeight + 24;
    dom.jumpToLatestButton.hidden = !historyPager?.hasNewer() && (viewState.followMessages || !hasOverflow);
  }

  function scrollToEnd() {
    if (scrollBehavior) return scrollBehavior.toEnd();
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
    if (emptyState.render) return emptyState.render(dom.messagesList);
    dom.messagesList.innerHTML = `
      <div class="empty-state chat-empty-state">
        <div class="mode-empty-title"></div>
        <div class="mode-empty-copy"></div>
      </div>
    `;
    dom.messagesList.querySelector(".mode-empty-title").textContent = emptyState.title;
    dom.messagesList.querySelector(".mode-empty-copy").textContent = emptyState.copy;
  }

  function createMessageNode(message) {
    const scheduleNode = conversationSchedule.createNode(message);
    if (scheduleNode) return scheduleNode;
    const row = documentRoot.createElement("article");
    row.dataset.messageId = String(message.id);
    row.dataset.requestId = message.requestId || "";
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

    const body = documentRoot.createElement("div");
    body.className = "markdown-body";
    applyTextDirection(body, message.text);
    body.innerHTML = message.text ? renderMarkdown(message.text) : "";

    bubble.appendChild(meta);
    const attachments = messageAttachments.createNode(message.attachments);
    if (attachments) bubble.appendChild(attachments);

    let activity = null;
    if (message.role !== "user" && message.requestId) {
      const activityInput = {
        requestId: message.requestId,
        streaming: Boolean(message.streaming),
        ...getActivityForMessage(message),
      };
      activity = conversationActivity.createNode(activityInput);
      if (activity) bubble.appendChild(activity);
    }

    const thinking = showReasoning ? conversationReasoning.createNode(message) : null;
    if (thinking) bubble.appendChild(thinking);

    bubble.appendChild(body);
    const status = conversationStatus.createNode(message);
    if (status && statusPlacement === "bubble") bubble.appendChild(status);
    const linkPreviews = messageLinkPreviews.createNode(message);
    if (linkPreviews) bubble.appendChild(linkPreviews);
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
    const initiativeAction = sparkActions.createNode(message);
    if (initiativeAction) bubble.appendChild(initiativeAction);
    row.appendChild(bubble);
    if (status && statusPlacement === "outside") {
      const hasVisibleContent = Boolean(message.text || attachments || activity || thinking || linkPreviews || initiativeAction);
      bubble.hidden = !hasVisibleContent;
      row.classList.add("message-status-outside");
      row.appendChild(status);
    }
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
    filePreview.syncScope();
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
      !holdingPosition && !historyPager?.hasNewer() && (viewState.followMessages || isNearScrollEnd(dom.messagesList));
    const messages = preserveMessageHistory ? getMessages() : projectApprovalContinuations(getMessages());
    conversationReasoning.beginRender(messages);
    messageLinkPreviews.reset();
    conversationStatus.reset();
    const restoreRejectionFocus = captureApprovalRejectionFocus(
      dom.messagesList,
      documentRoot,
    );
    dom.messagesList.innerHTML = "";
    if (messages.length === 0) {
      renderEmptyState();
      viewState.followMessages = true;
      updateJumpToLatest();
      scrollBehavior?.afterRender();
      return;
    }
    for (const message of messages) {
      dom.messagesList.appendChild(createMessageNode(message));
    }
    for (const pendingApproval of getPendingApprovals()) {
      dom.messagesList.appendChild(createApprovalCard(pendingApproval));
    }
    restoreRejectionFocus();
    historyPager?.renderControls(dom.messagesList);
    if (scrollBehavior) {
      scrollBehavior.afterRender();
      if (historyPager?.hasNewer()) dom.jumpToLatestButton.hidden = false;
      return;
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

  function preserveScroll(change) {
    const root = dom.messagesList;
    const bounds = root.getBoundingClientRect();
    const anchor = [...root.querySelectorAll("[data-message-id]")].find((node) => node.getBoundingClientRect().bottom > bounds.top);
    const id = anchor?.dataset.messageId;
    const offset = anchor?.getBoundingClientRect().top ?? 0;
    const previousTop = root.scrollTop;
    holdingPosition = true; viewState.followMessages = false; viewState.scrollSettleVersion += 1;
    change();
    const restored = [...root.querySelectorAll("[data-message-id]")].find((node) => node.dataset.messageId === id);
    root.scrollTop = restored ? root.scrollTop + restored.getBoundingClientRect().top - offset : previousTop;
    scrollBehavior?.preservePosition?.();
    updateJumpToLatest();
  }

  function reset() {
    holdingPosition = false;
    filePreview.reset();
    viewState.followMessages = true;
    viewState.scrollSettleVersion += 1;
    cancelScheduledMessageRender();
    cancelScheduledThinkingRender();
    conversationActivity.reset();
    conversationReasoning.reset();
    conversationStatus.reset();
    conversationSchedule.reset();
    composerContextWindow.reset();
    composerPlan.reset();
    messageLinkPreviews.reset();
  }

  function jumpToLatest() {
    if (!historyPager?.hasNewer()) { scrollToEnd(); return; }
    void historyPager.latest().then(scrollToEnd).catch(() => notify("Could not load latest messages", "failed"));
  }

  function bind() {
    if (viewState.bound) return;
    viewState.bound = true;
    dom.jumpToLatestButton.addEventListener("click", jumpToLatest);
    dom.messagesList.addEventListener("scroll", () => {
      holdingPosition = false;
      if (scrollBehavior) return;
      viewState.followMessages = !historyPager?.hasNewer() && isNearScrollEnd(dom.messagesList);
      if (!viewState.followMessages) viewState.scrollSettleVersion += 1;
      updateJumpToLatest();
    });
  }

  return {
    preserveScroll,
    setHistoryPager: (pager) => { historyPager = pager; },
    setWorkspace: filePreview.setWorkspace,
    closeFilePreview: filePreview.reset,
    bind,
    cancelScheduledMessageRender,
    cancelScheduledThinkingRender,
    render,
    renderActivityStatus: conversationStatus.render,
    renderContextWindow,
    reset,
    scheduleMessageRender,
    scheduleThinkingRender,
  };
}
