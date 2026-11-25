import { mountNotificationsDom } from "./components/notifications/dom.js";
import { createNotificationsWorkspace } from "./components/notifications/workspace.js";
import { createNotificationsController } from "./controllers/notifications-controller.js";
import { createNotificationPresence } from "./controllers/notification-presence.js";
import { createHomeNotificationsEntry } from "./components/notifications/home-entry.js";
import { createHomeErrorAttention } from "./components/notifications/home-error-attention.js";
import { createNotificationFavicon } from "./components/notifications/favicon.js";
import { notificationSourceUrl } from "./components/notifications/presentation.js";
import { sparkNotificationReference } from "./lib/spark-chat-address.js";

function isNotificationSummaryWorkspace(workspace) {
  return ["notifications", "home"].includes(workspace);
}

export function createNotificationsFeature({ dom, state, client, shell, getEnvironmentId, send, reviewStepTimeout }) {
  mountNotificationsDom(dom);
  const favicon = createNotificationFavicon();
  let view;
  let companionChat, agents;
  let environmentRevision = 0;
  const openUnread = async () => {
    const environment = getEnvironmentId();
    const revision = environmentRevision;
    const activate = await shell.prepareWorkspaceActivation("notifications");
    if (!activate || revision !== environmentRevision) return;
    if (environment !== getEnvironmentId()) return;
    if (!activate()) return;
    controller.setFilter("unread");
  };
  const homeEntry = createHomeNotificationsEntry({
    homePanel: dom.homeWorkspacePanel, onOpen: openUnread,
  });
  const homeErrors = createHomeErrorAttention({
    homePanel: dom.homeWorkspacePanel, onOpen: openUnread,
  });
  const controller = createNotificationsController({
    client, getEnvironmentId, render: (snapshot) => {
      view?.render(snapshot);
      homeEntry.render(snapshot);
      homeErrors.render(snapshot);
      refreshAvailability();
    },
  });
  const presence = createNotificationPresence({
    getEnvironmentId,
    getSessionId: () => state.currentSessionId,
    getAgentId: () => agents?.selectedId?.() || "",
    getWorkspace: shell.activeWorkspace,
    isConnected: () => state.connected && client.supportsNotifications(),
    send,
  });
  function canOpenNotificationSource(item) {
    if (!client.supportsNotifications()) return false;
    if (item.environmentId !== getEnvironmentId()) return false;
    return shell.activeWorkspace() === "notifications";
  }
  async function openCompanionSource(item, source) {
    if (!companionChat) return false;
    const address = new URL(source, window.location.href);
    if (address.searchParams.get("spark") !== "1") return false;
    return companionChat.openSession(item.sessionId, address.searchParams.get("message"), sparkNotificationReference(address));
  }
  async function openNotificationSource(item) {
    if (!canOpenNotificationSource(item)) return;
    const source = notificationSourceUrl(item);
    if (!source) return;
    const environmentVersion = environmentRevision;
    const navigationVersion = shell.navigationRevision();
    const navigationRequest = shell.navigationRequestRevision?.();
    await controller.markRead(item.id, true);
    if (!canOpenNotificationSource(item)) return;
    if (environmentVersion !== environmentRevision) return;
    if (navigationVersion !== shell.navigationRevision()) return;
    if (navigationRequest !== shell.navigationRequestRevision?.()) return;
    if (await openCompanionSource(item, source)) return;
    if (!canOpenNotificationSource(item)) return;
    if (environmentVersion !== environmentRevision) return;
    if (navigationVersion !== shell.navigationRevision()) return;
    if (navigationRequest !== shell.navigationRequestRevision?.()) return;
    window.location.assign(source);
  }
  async function reviewIssue(item) {
    if (!canOpenNotificationSource(item) || item.severity !== "error") return;
    const action = item.issue?.action;
    if (action?.kind === "model-settings") {
      await shell.activateWorkspace("models");
      return;
    }
    if (action?.kind !== "step-timeout" || !reviewStepTimeout) return;
    if (action.reference?.environment !== getEnvironmentId()) return;
    const revision = environmentRevision;
    const navigation = shell.navigationRevision();
    try {
      await reviewStepTimeout(action.reference);
    } catch (error) {
      if (revision !== environmentRevision || navigation !== shell.navigationRevision()) return;
      controller.reportError(error);
    }
  }
  function refreshAvailability() {
    favicon.render(controller.snapshot());
    const available = client.supportsNotifications();
    dom.notificationsWorkspaceButton.hidden = !available;
    dom.notificationsWorkspaceButton.disabled = !available || dom.notificationsWorkspaceButton.dataset.onboardingBlocked === "true";
    if (available) return;
    if (shell.activeWorkspace() !== "notifications") return;
    shell.activateWorkspace("chat", { focus: false });
  }
  view = createNotificationsWorkspace({
    root: dom.notificationsRoot,
    button: dom.notificationsWorkspaceButton,
    badge: dom.notificationsBadge,
    actions: { ...controller, openSource: openNotificationSource, reviewIssue },
  });
  controller.publish();
  return {
    ...controller,
    setAgents(value) { agents = value; },
    setCompanionChat(companion) { companionChat = companion; },
    refreshAvailability,
    isWorkspaceAvailable(destination) {
      if (destination !== "notifications") return true;
      return client.supportsNotifications();
    },
    bind() {
      presence.bind();
      document.addEventListener("visibilitychange", controller.visibilityChanged);
    },
    presenceChanged: presence.changed,
    workspaceChanged(workspace) {
      presence.changed();
      controller.setActive(isNotificationSummaryWorkspace(workspace));
    },
    environmentChanged() {
      environmentRevision += 1;
      presence.changed();
      controller.environmentChanged();
    },
    reconnect() {
      presence.reconnect();
      void controller.refresh();
    },
  };
}
