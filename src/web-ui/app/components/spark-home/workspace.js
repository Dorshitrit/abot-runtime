import { createSparkHomeWidgetOverlay } from "./widget-overlay.js";

/** Host controls stay outside the isolated model-authored document. */
export function createSparkHomeWorkspace({
  root, dashboardRoot, contentUrl, onMode, onRequest, onTalk, onSetup, onRetry, onContentError, widgets,
  documentRoot = root.ownerDocument, windowRoot = documentRoot.defaultView || globalThis.window,
}) {
  const element = (tag, className, text = "") => {
    const node = documentRoot.createElement(tag);
    node.className = className;
    node.textContent = text;
    return node;
  };
  const button = (className, text, action) => {
    const node = element("button", className);
    node.appendChild(element("span", "spark-home-button-label", text));
    node.type = "button"; node.addEventListener("click", action);
    return node;
  };
  const labelButton = (node, text) => { node.querySelector(".spark-home-button-label").textContent = text; };
  const controls = element("div", "spark-home-controls");
  const selector = element("div", "spark-home-selector");
  selector.setAttribute("role", "group");
  selector.setAttribute("aria-label", "Home view");
  const dashboardButton = button("spark-home-mode", "Dashboard", () => onMode("dashboard"));
  const sparkButton = button("spark-home-mode", "SPARK HOME", () => onMode("spark"));
  selector.append(dashboardButton, sparkButton);
  controls.appendChild(selector);

  const surface = element("section", "spark-home-surface");
  surface.id = "sparkHomePanel";
  surface.setAttribute("aria-label", "SPARK HOME");
  dashboardButton.setAttribute("aria-controls", "homeDashboardRoot");
  sparkButton.setAttribute("aria-controls", surface.id);
  surface.hidden = true;
  const toolbar = element("div", "spark-home-toolbar");
  const newButton = button("spark-home-action spark-home-primary", "Request new screen", onRequest);
  const talkButton = button("spark-home-action", "Talk to SPARK", onTalk);
  toolbar.append(newButton, talkButton);
  controls.appendChild(toolbar);
  root.querySelector(".home-workspace-header").appendChild(controls);
  const status = element("p", "spark-home-status");
  status.setAttribute("role", "status");
  const failure = element("div", "spark-home-feedback");
  failure.setAttribute("role", "status");
  const errorText = element("p", "");
  const retry = button("spark-home-action", "Try loading again", onRetry);
  failure.append(errorText, retry);
  const preferenceError = element("p", "spark-home-preference-error");
  preferenceError.setAttribute("role", "status");
  root.appendChild(preferenceError);
  const empty = element("div", "spark-home-empty");
  const heading = element("h2", "", "Your space, shaped by SPARK");
  const hint = element("p", "", "Ask SPARK to create a focused screen from what matters to you.");
  const createButton = button("spark-home-create spark-home-primary", "Ask SPARK to create a screen", onRequest);
  const setupButton = button("spark-home-create spark-home-setup", "Set up SPARK", onSetup);
  empty.append(heading, hint, createButton, setupButton);
  const frameHost = element("div", "spark-home-frame-host");
  const widgetOverlay = widgets ? createSparkHomeWidgetOverlay({ host: frameHost, widgets, documentRoot, windowRoot }) : null;
  const generation = element("div", "spark-home-generation");
  const mascotHost = element("div", "spark-home-generation-mascot");
  const mascot = element("img", "spark-pet");
  mascot.setAttribute("src", "/spark-mascot.svg"); mascot.setAttribute("alt", "");
  const attentionMark = element("span", "spark-home-approval-mark", "!");
  attentionMark.setAttribute("aria-hidden", "true"); attentionMark.hidden = true;
  mascotHost.append(mascot, attentionMark);
  const generationText = element("p", "spark-home-generation-text");
  generationText.setAttribute("role", "status"); generationText.setAttribute("aria-atomic", "true");
  const approvalHint = element("p", "spark-home-approval-hint", "Screen creation is paused. Review the request to continue.");
  approvalHint.hidden = true;
  const generationAction = button("spark-home-action spark-home-generation-action", "Open SPARK", onTalk);
  generation.append(mascotHost, generationText, approvalHint, generationAction);
  const notice = element("div", "spark-home-feedback spark-home-generation-notice");
  const noticeText = element("p", ""); noticeText.setAttribute("role", "status");
  notice.append(noticeText, button("spark-home-action", "Open SPARK", onTalk));
  surface.append(status, failure, notice, empty, frameHost, generation);
  root.appendChild(surface);
  let frameKey = "";
  let currentFrame;
  let expectedRevision;
  function isCurrentScreenLoadFailure(event) {
    if (!currentFrame || event.source !== currentFrame.contentWindow) return false;
    if (event.data?.kind !== "abot.spark-home-load-error") return false;
    if (event.data.error !== "spark_home_content_unavailable") return false;
    return event.data.revision === expectedRevision;
  }
  windowRoot?.addEventListener("message", (event) => {
    if (isCurrentScreenLoadFailure(event)) onContentError?.();
  });

  function renderScreen(state) {
    if (!state.screen || state.configured === false) {
      if (frameKey) frameHost.replaceChildren();
      frameKey = ""; currentFrame = undefined; expectedRevision = undefined; return;
    }
    const key = JSON.stringify([state.environmentId, state.screen.revision, state.screen.updatedAt]);
    if (frameKey === key) return;
    const frame = element("iframe", "spark-home-frame");
    frame.setAttribute("title", "Your SPARK HOME");
    frame.setAttribute("sandbox", "allow-scripts");
    frame.setAttribute("referrerpolicy", "no-referrer");
    frame.setAttribute("src", contentUrl(state.screen.revision, state.environmentId));
    currentFrame = frame; expectedRevision = state.screen.revision;
    frameHost.replaceChildren(frame);
    frameKey = key;
  }
  function isInitialSparkHomeLoad(state) {
    if (state.screen) return false;
    return state.loading;
  }
  function statusText(state) {
    if (state.generationPhase) return "";
    if (state.configurationLoading) return "Loading SPARK configuration…";
    if (state.configurationKnown === false) return "SPARK is unavailable. Check Runtime settings.";
    if (state.configurationKnown !== false && state.configured === false) return "";
    if (state.requesting) return "Sending HOME request…";
    if (isInitialSparkHomeLoad(state)) return "Loading SPARK HOME…";
    if (!state.available) return "SPARK is unavailable. Check its model and Runtime settings.";
    return "";
  }
  function renderGeneration(state) {
    const phase = state.generationPhase || "";
    const needsApproval = phase === "approval";
    const busy = phase === "working" || phase === "finishing";
    generation.hidden = !phase;
    generation.classList.toggle("spark-is-working", busy);
    generation.classList.toggle("spark-home-needs-approval", needsApproval);
    attentionMark.hidden = !needsApproval; approvalHint.hidden = !needsApproval;
    generationText.setAttribute("aria-live", needsApproval ? "assertive" : "polite");
    labelButton(generationAction, needsApproval ? "Review in SPARK" : "Open SPARK");
    surface.classList.toggle("spark-home-generating", Boolean(phase));
    frameHost.inert = Boolean(phase); empty.inert = Boolean(phase);
    const labels = {
      working: "SPARK is creating your screen…", finishing: "Loading your updated screen…",
      approval: "Your approval is needed",
      reconnecting: "Reconnecting to SPARK. Your request may still be running.",
    };
    const label = labels[phase] || "";
    if (generationText.textContent !== label) generationText.textContent = label;
    noticeText.textContent = state.generationNotice || "";
    notice.hidden = !state.generationNotice || Boolean(phase);
  }
  function sparkHomeEmptyHint(state, needsSetup) {
    if (needsSetup && needsSparkConfiguration(state)) return "Choose an available model in SPARK settings before setting up HOME.";
    if (needsSetup) return "Choose and save an EA model in HOME settings to use your personal home screen.";
    if (state.available) return "Ask SPARK to create a focused screen from what matters to you.";
    return "SPARK needs an available Runtime and a selected model. You can return to Dashboard at any time.";
  }
  function needsSparkConfiguration(state) {
    return ["spark_chat_model_required", "spark_chat_model_unavailable"].includes(state.reason);
  }
  return {
    render(state) {
      const isSpark = state.mode === "spark";
      const needsSetup = state.configurationKnown !== false && state.configured === false;
      root.dataset.homeMode = state.mode;
      dashboardRoot.hidden = isSpark; surface.hidden = !isSpark; toolbar.hidden = !isSpark || state.configured === false;
      dashboardButton.hidden = !isSpark; sparkButton.hidden = isSpark;
      dashboardButton.disabled = state.saving; sparkButton.disabled = state.saving;
      preferenceError.textContent = state.preferenceError;
      preferenceError.hidden = !state.preferenceError;
      newButton.hidden = !state.screen;
      newButton.disabled = state.requesting || Boolean(state.generationPhase) || !state.available;
      for (const control of [newButton, createButton]) control.setAttribute("aria-busy", String(state.requesting));
      labelButton(newButton, state.requesting ? "Creating…" : "Request new screen");
      labelButton(createButton, state.requesting ? "Creating…" : "Ask SPARK to create a screen");
      createButton.disabled = state.requesting || Boolean(state.generationPhase) || state.loading || !state.available;
      talkButton.disabled = !state.available;
      empty.hidden = state.configurationKnown === false || (!needsSetup && (Boolean(state.screen) || state.loading));
      heading.textContent = needsSetup ? "Set up your HOME" : "Your space, shaped by SPARK";
      labelButton(setupButton, needsSparkConfiguration(state) ? "Set up SPARK" : "Set up HOME");
      createButton.hidden = needsSetup; setupButton.hidden = !needsSetup;
      hint.textContent = sparkHomeEmptyHint(state, needsSetup);
      status.textContent = statusText(state); status.hidden = !status.textContent;
      errorText.textContent = state.error; failure.hidden = !state.error || state.configured === false;
      retry.disabled = state.loading;
      frameHost.hidden = !state.screen || state.configured === false;
      renderGeneration(state);
      renderScreen(state);
      widgetOverlay?.bind(currentFrame, state);
    },
  };
}
