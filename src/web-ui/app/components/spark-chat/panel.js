const mascot = '<img class="spark-pet" src="/spark-mascot.svg" alt="" aria-hidden="true" draggable="false" />';

export function createSparkChatPanel({ documentRoot = document, launcherAnchor }) {
  const root = documentRoot.createElement("aside");
  root.className = "spark-companion";
  root.hidden = true;
  root.innerHTML = `
    <section class="spark-chat-panel" role="dialog" aria-label="ABot SPARK chat" hidden>
      <header class="spark-chat-header">
        <button type="button" class="spark-header-mascot" data-spark="mascotButton" aria-label="Minimize SPARK chat" title="Minimize SPARK chat">${mascot}</button>
        <div class="spark-chat-identity"><strong>ABot SPARK</strong></div>
        <div class="spark-header-actions">
          <button type="button" data-spark="settingsButton" aria-label="SPARK settings" title="SPARK settings"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 17h16" /><circle cx="9" cy="7" r="3" /><circle cx="15" cy="17" r="3" /></svg></button>
          <button type="button" data-spark="closeButton" aria-label="Minimize SPARK chat" title="Minimize"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 12h12" /></svg></button>
        </div>
      </header>
      <div class="spark-chat-content">
        <div class="messages-list spark-messages" data-spark="messagesList" role="log" aria-label="SPARK messages" tabindex="0"></div>
        <button type="button" class="jump-to-latest" data-spark="jumpToLatestButton" hidden>Latest ↓</button>
      </div>
      <div class="spark-chat-composer-dock">
        <div data-spark="composerPlan"></div><div data-spark="composerContextWindow"></div>
        <form class="spark-compose" data-spark="composerForm">
          <div class="attachment-preview" data-spark="attachmentPreview"></div>
          <div class="spark-input-row">
            <button type="button" class="spark-input-icon" data-spark="attachmentButton" aria-label="Attach a file" title="Attach a file">＋</button>
            <textarea data-spark="composerInput" rows="1" dir="auto" aria-label="Message SPARK" placeholder="Message SPARK…"></textarea>
            <button type="button" class="spark-input-icon spark-stop" data-spark="stopButton" aria-label="Stop response" title="Stop response" hidden><span aria-hidden="true">■</span></button>
            <div class="composer-submit-control" data-spark="composerSubmitControl">
              <button type="submit" class="send-button" data-spark="sendButton" aria-label="Send"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 11 6-6 6 6M12 5v14" /></svg><span class="sr-only" data-spark="sendButtonLabel">Send</span></button>
              <button type="button" data-spark="sendNextMenuButton" class="send-next-menu-button" aria-label="More send options" aria-expanded="false" hidden><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg></button>
              <div data-spark="sendNextMenu" class="send-next-menu" hidden><button type="button" data-spark="sendNextButton" aria-describedby="spark-send-next-hint">Send next</button><p id="spark-send-next-hint">Wait until this reply is finished.</p></div>
            </div>
          </div>
          <input type="file" data-spark="attachmentInput" hidden multiple>
        </form>
        <p class="spark-chat-status" data-spark="messageStatusRegion" role="status" aria-live="polite"></p>
      </div>
    </section>
    <div class="spark-message-notice" hidden role="status" aria-live="polite">
      <button type="button" data-spark="noticeButton" dir="auto"></button>
      <button type="button" data-spark="dismissNoticeButton" aria-label="Dismiss message preview">×</button>
    </div>
    <button type="button" class="spark-launcher" data-spark="launcherButton" aria-label="Open SPARK chat" aria-expanded="false">${mascot}<span class="spark-unread" data-spark="unreadBadge" hidden></span></button>`;
  documentRoot.body.append(root);
  const dom = Object.fromEntries([...root.querySelectorAll("[data-spark]")].map((node) => [node.dataset.spark, node]));
  const launcherSlot = documentRoot.createElement("div");
  launcherSlot.className = "spark-rail-launcher";
  launcherSlot.hidden = true;
  launcherSlot.append(dom.launcherButton);
  launcherAnchor?.before(launcherSlot);
  dom.launcherButton.insertAdjacentHTML("beforeend", '<span class="spark-launcher-label">SPARK</span>');
  const panel = root.querySelector(".spark-chat-panel");
  const notice = root.querySelector(".spark-message-notice");
  dom.launcherButton.hidden = true;
  const placement = createSparkChatPlacement({ root, launcher: dom.launcherButton, panel, notice, dockAnchor: launcherSlot });
  dom.launcherButton.title = "Open SPARK · Drag to move · Alt + arrows to move · Alt + Home to return to sidebar";
  let timer;
  let previousFocus;
  let open = false;
  let onToggle = () => {};

  function setOpen(value, { focus = true } = {}) {
    if (open === value) return;
    if (value) previousFocus = documentRoot.activeElement;
    open = value;
    panel.hidden = !value;
    dom.launcherButton.setAttribute("aria-expanded", String(value));
    if (value) notice.hidden = true;
    placement.refresh();
    onToggle(value);
    if (!focus) return;
    if (value) dom.composerInput.focus({ preventScroll: true });
    else (previousFocus?.isConnected ? previousFocus : dom.launcherButton)?.focus({ preventScroll: true });
  }

  function showNotice(text) {
    if (open) return;
    clearTimeout(timer);
    dom.noticeButton.textContent = text;
    notice.hidden = false;
    placement.refresh();
    timer = setTimeout(() => { notice.hidden = true; }, 7000);
  }
  dom.launcherButton.addEventListener("click", () => setOpen(!open));
  dom.closeButton.addEventListener("click", () => setOpen(false));
  dom.mascotButton.addEventListener("click", () => setOpen(false));
  dom.noticeButton.addEventListener("click", () => setOpen(true));
  dom.dismissNoticeButton.addEventListener("click", () => { notice.hidden = true; });
  root.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !open) return;
    if (!dom.sendNextMenu.hidden) return;
    event.preventDefault(); event.stopPropagation(); setOpen(false);
  });
  return {
    dom, root, panel, isOpen: () => open, setOpen,
    onToggle(callback) { onToggle = callback; },
    setAvailable(available) {
      const availabilityChanged = available !== !root.hidden;
      root.hidden = !available; launcherSlot.hidden = !available; dom.launcherButton.hidden = !available;
      if (!available) setOpen(false, { focus: false });
      if (availabilityChanged) placement.refresh();
    },
    resetPosition: placement.reset,
    showNotice,
    hideNotice() { clearTimeout(timer); notice.hidden = true; },
    setUnread(count) {
      dom.unreadBadge.hidden = !count;
      dom.unreadBadge.textContent = String(count);
      dom.launcherButton.setAttribute("aria-label", count ? `Open SPARK chat, ${count} unread messages` : "Open SPARK chat");
    },
  };
}
import { createSparkChatPlacement } from "./placement.js";
