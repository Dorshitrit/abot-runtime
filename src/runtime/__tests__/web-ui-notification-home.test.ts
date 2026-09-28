import { expect, test, vi } from "vitest";
// @ts-expect-error Browser-only component.
import { createHomeNotificationsEntry } from "../../web-ui/app/components/notifications/home-entry.js";
// @ts-expect-error Browser-only controller.
import { createNotificationsController } from "../../web-ui/app/controllers/notifications-controller.js";
import { FakeElement } from "./support/model-setup-wizard-harness.js";

function homeEntry() {
  const document = {} as ConstructorParameters<typeof FakeElement>[1];
  document.createElement = (tag) => new FakeElement(tag, document);
  const panel = document.createElement("section");
  panel.innerHTML = '<header class="home-workspace-header"><h1>Home</h1></header>';
  const onOpen = vi.fn();
  const entry = createHomeNotificationsEntry({ homePanel: panel, onOpen });
  return { entry, onOpen, button: panel.querySelector("button")! };
}

test("Home follows the shared inbox count and clears immediately on environment change", async () => {
  const home = homeEntry();
  let environment = "prod";
  let unreadCount = 3;
  const client = {
    supportsNotifications: () => true,
    listNotifications: vi.fn(async () => ({ items: [], unreadCount })),
    markNotificationsRead: vi.fn(async () => { unreadCount = 0; }),
  };
  const controller = createNotificationsController({
    client, getEnvironmentId: () => environment, render: home.entry.render,
    isVisible: () => true,
  });
  expect(home.button.hidden).toBe(true);
  await controller.setReady();
  expect(home.button.hidden).toBe(false);
  expect(home.button.attributes.get("aria-label")).toBe("View 3 unread notifications");
  home.button.dispatch("click");
  expect(home.onOpen).toHaveBeenCalledOnce();
  expect(client.markNotificationsRead).not.toHaveBeenCalled();
  expect(client.listNotifications).toHaveBeenCalledOnce();

  environment = "dev";
  unreadCount = 1;
  controller.environmentChanged();
  expect(home.button.hidden).toBe(true);
  await controller.refresh();
  expect(home.button.attributes.get("aria-label")).toBe("View 1 unread notification");
  await controller.markAllRead();
  expect(home.button.hidden).toBe(true);
  home.button.dispatch("click");
  expect(home.onOpen).toHaveBeenCalledOnce();
  controller.dispose();
});

test("Home hides the unread entry with the bridge backend", () => {
  const home = homeEntry();
  home.entry.render({ supported: false, unreadCount: 3 });
  expect(home.button.hidden).toBe(true);
  home.button.dispatch("click");
  expect(home.onOpen).not.toHaveBeenCalled();
});
