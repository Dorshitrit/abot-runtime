import { expect, test, vi } from "vitest";
// @ts-expect-error Browser-only module.
import { createSystemHostSetupNotice } from "../../web-ui/app/components/system-host/setup-notice.js";
// @ts-expect-error Browser-only module.
import { createSystemHostConnectionManager } from "../../web-ui/app/components/system-host/manager.js";

function connectionState(environment = "container") {
  return {
    busy: false,
    statusUnavailable: false,
    snapshot: {
      paired: false,
      connected: false,
      readiness: {
        ready: false,
        route: "setup_required",
        environment,
        platforms: ["windows", "macos"],
      },
    },
  };
}

function harness(
  initial: any = connectionState(),
  supported = true,
  refreshConnection = vi.fn(),
) {
  let state = initial;
  let hidden = false;
  let visibilityChanged = () => {};
  const observerDisconnect = vi.fn();
  const documentRoot = {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    defaultView: {
      MutationObserver: class {
        constructor(callback: () => void) {
          visibilityChanged = callback;
        }
        observe() {}
        disconnect() {
          observerDisconnect();
        }
      },
    },
  };
  const openListeners = new Map<string, () => void>();
  const dismissListeners = new Map<string, () => void>();
  const description = { textContent: "" };
  const open = {
    addEventListener: (key: string, fn: () => void) =>
      openListeners.set(key, fn),
  };
  const dismiss = {
    addEventListener: (key: string, fn: () => void) =>
      dismissListeners.set(key, fn),
  };
  const paint = vi.fn();
  const root = {
    hidden: false,
    className: "",
    setAttribute: vi.fn(),
    set innerHTML(value: string) {
      paint(value);
    },
    querySelector(selector: string) {
      if (selector === "[data-host-setup-description]") return description;
      return selector === "[data-host-setup-open]" ? open : dismiss;
    },
    remove: vi.fn(),
  };
  const container = {
    ownerDocument: { ...documentRoot, createElement: vi.fn(() => root) },
    prepend: vi.fn(),
  };
  const onOpen = vi.fn();
  const notice = createSystemHostSetupNotice({
    container,
    conversationRegion: { closest: () => (hidden ? {} : null) },
    getConnectionState: () => state,
    supportsConnection: () => supported,
    refreshConnection,
    onOpen,
  });
  return {
    root,
    description,
    paint,
    container,
    notice,
    onOpen,
    refreshConnection,
    observerDisconnect,
    visibility(hiddenValue: boolean) {
      hidden = hiddenValue;
      visibilityChanged();
    },
    open: () => openListeners.get("click")?.(),
    dismiss: () => dismissListeners.get("click")?.(),
    update(next: any) {
      state = next;
      notice.render();
    },
  };
}

test.each(["container", "wsl"])(
  "offers setup for trusted %s readiness",
  (environment) => {
    const view = harness(connectionState(environment));
    expect(view.root.hidden).toBe(false);
    expect(view.container.prepend).toHaveBeenCalledWith(view.root);
    expect(view.description.textContent).toContain(
      environment === "wsl" ? "Windows" : "your computer",
    );
    view.open();
    expect(view.onOpen).toHaveBeenCalledOnce();
  },
);

test.each([
  ["unknown status", null],
  ["loading", { ...connectionState(), busy: true }],
  ["failed status", { ...connectionState(), statusUnavailable: true }],
  ["native environment", connectionState("native")],
  ["unknown environment", connectionState("other")],
  ["legacy server", { snapshot: { paired: false, connected: false } }],
])("does not suggest setup from %s", (_label, state) => {
  const view = harness(state);
  expect(view.root.hidden).toBe(true);
  view.open();
  expect(view.onOpen).not.toHaveBeenCalled();
});

test.each([
  ["native", "native"],
  ["wsl", "wsl_interop"],
  ["container", "companion"],
])("does not suggest setup for ready %s", (environment, route) => {
  const state = connectionState(environment);
  state.snapshot.readiness.ready = true;
  state.snapshot.readiness.route = route;
  expect(harness(state).root.hidden).toBe(true);
});

test("paired but offline does not recommend reinstalling", () => {
  const state = connectionState();
  state.snapshot.paired = true;
  expect(harness(state).root.hidden).toBe(true);
});

test.each([
  { route: "companion" },
  { platforms: [] },
  { platforms: ["unsupported"] },
  { platforms: "windows" },
])("requires a known actionable setup route: %j", (override) => {
  const state = connectionState();
  Object.assign(state.snapshot.readiness, override);
  expect(harness(state).root.hidden).toBe(true);
});

test("unsupported backend never displays a setup action", () => {
  expect(harness(connectionState(), false).root.hidden).toBe(true);
});

test("existing notice hides immediately when readiness succeeds or refresh fails", () => {
  const view = harness();
  const ready = connectionState();
  ready.snapshot.readiness.ready = true;
  view.update(ready);
  expect(view.root.hidden).toBe(true);
  view.update(connectionState());
  expect(view.root.hidden).toBe(false);
  view.update({ ...connectionState(), statusUnavailable: true });
  expect(view.root.hidden).toBe(true);
});

test("dismissal lasts for this component lifetime across status refreshes", () => {
  const view = harness();
  view.dismiss();
  view.update(connectionState("wsl"));
  expect(view.root.hidden).toBe(true);
  view.open();
  expect(view.onOpen).not.toHaveBeenCalled();
  expect(harness().root.hidden).toBe(false);
});

test("unchanged status and environment updates retain the same controls", () => {
  const view = harness();
  view.update(connectionState());
  view.update(connectionState("wsl"));
  expect(view.paint).toHaveBeenCalledOnce();
  expect(view.container.ownerDocument.createElement).toHaveBeenCalledOnce();
  expect(view.description.textContent).toContain("Windows");
  view.open();
  expect(view.onOpen).toHaveBeenCalledOnce();
});

test("disposed notices stop updating", () => {
  const view = harness();
  const previous = view.description.textContent;
  view.notice.dispose();
  view.update(connectionState("wsl"));
  expect(view.root.remove).toHaveBeenCalledOnce();
  expect(view.description.textContent).toBe(previous);
  view.visibility(true);
  view.visibility(false);
  expect(view.refreshConnection).not.toHaveBeenCalled();
  expect(view.observerDisconnect).toHaveBeenCalledTimes(2);
});

test("Chat or onboarding reentry refreshes once without polling or initial duplicate load", () => {
  const view = harness();
  expect(view.refreshConnection).not.toHaveBeenCalled();
  view.visibility(true);
  view.visibility(true);
  expect(view.refreshConnection).not.toHaveBeenCalled();
  view.visibility(false);
  view.visibility(false);
  expect(view.refreshConnection).toHaveBeenCalledOnce();
  expect(view.paint).toHaveBeenCalledOnce();
});

test("reentry shares the manager pending request and clears the notice after setup succeeds", async () => {
  let resolve!: (value: unknown) => void;
  const pending = new Promise((done) => {
    resolve = done;
  });
  const loadConnection = vi
    .fn()
    .mockResolvedValueOnce(connectionState().snapshot)
    .mockReturnValue(pending);
  let update: (() => void) | undefined;
  const manager = createSystemHostConnectionManager({
    loadConnection,
    onChange: () => update?.(),
  });
  await manager.load();
  const view = harness(
    manager.state,
    true,
    vi.fn(() => manager.load(true)),
  );
  update = () => view.update(manager.state);
  view.visibility(true);
  view.visibility(false);
  view.visibility(true);
  view.visibility(false);
  expect(loadConnection).toHaveBeenCalledTimes(2);
  const ready = connectionState().snapshot;
  ready.readiness.ready = true;
  resolve(ready);
  await vi.waitFor(() => expect(view.root.hidden).toBe(true));
  expect(view.paint).toHaveBeenCalledOnce();
  view.notice.dispose();
  manager.dispose();
});
