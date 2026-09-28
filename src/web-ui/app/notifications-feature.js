import { mountNotificationsDom } from "./components/notifications/dom.js";
import { createNotificationsWorkspace } from "./components/notifications/workspace.js";
import { createNotificationsController } from "./controllers/notifications-controller.js";
import { createNotificationPresence } from "./controllers/notification-presence.js";
import { createHomeNotificationsEntry } from "./components/notifications/home-entry.js";
import { notificationSourceUrl } from "./components/notifications/presentation.js";

function isNotificationSummaryWorkspace(workspace) {
  return ["notifications", "home"].includes(workspace);
}

export function createNotificationsFeature({ dom, state, client, shell, getEnvironmentId, send }) {
  mountNotificationsDom(dom);
  let view;
  let environmentRevision = 0;
  const homeEntry = createHomeNotificationsEntry({
    homePanel: dom.homeWorkspacePanel,
    onOpen: () => {
      if (!shell.activateWorkspace("notifications")) return;
      controller.setFilter("unread");
    },
  });
  const controller = createNotificationsController({
    client, getEnvironmentId, render: (snapshot) => {
      view?.render(snapshot);
      homeEntry.render(snapshot);
      refreshAvailability();
    },
  });
  const presence = createNotificationPresence({
    getEnvironmentId,
    getSessionId: () => state.currentSessionId,
    getWorkspace: shell.activeWorkspace,
    isConnected: () => state.connected && client.supportsNotifications(),
    send,
  });
  function canOpenNotificationSource(item) {
    if (!client.supportsNotifications()) return false;
    if (item.environmentId !== getEnvironmentId()) return false;
    return shell.activeWorkspace() === "notifications";
  }
  async function openNotificationSource(item) {
    if (!canOpenNotificationSource(item)) return;
    const source = notificationSourceUrl(item);
    if (!source) return;
    const environmentVersion = environmentRevision;
    const navigationVersion = shell.navigationRevision();
    await controller.markRead(item.id, true);
    if (!canOpenNotificationSource(item)) return;
    if (environmentVersion !== environmentRevision) return;
    if (navigationVersion !== shell.navigationRevision()) return;
    window.location.assign(source);
  }
  function refreshAvailability() {
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
    actions: { ...controller, openSource: openNotificationSource },
  });
  controller.publish();
  return {
    ...controller,
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
