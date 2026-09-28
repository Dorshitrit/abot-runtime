import { describe, expect, test, vi } from "vitest";
// @ts-expect-error Browser-only component has no declaration surface.
import { createMacCollectionConsent } from "../../web-ui/app/components/passive-learning/macos-collection-consent.js";

type ConsentSnapshot = {
  environmentId: string;
  status: { preferences: { enabled: boolean } };
  saving: boolean;
  hostConnection: {
    paired: boolean;
    connected: boolean;
    hostId: string;
    connectionId: string;
    identity: { os: string; homeDir?: string };
    companion?: { installedVersion?: number };
  };
};

function managedMacSnapshot(): ConsentSnapshot {
  return {
    environmentId: "dev",
    status: { preferences: { enabled: false } },
    saving: false,
    hostConnection: {
      paired: true,
      connected: true,
      hostId: "mac-one",
      connectionId: "connection-one",
      identity: { os: "macos", homeDir: "/fixture/alice" },
      companion: { installedVersion: 6 },
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function consentHarness() {
  const state = { snapshot: managedMacSnapshot() };
  const confirmations: ReturnType<typeof deferred<boolean>>[] = [];
  const dialog = {
    confirm: vi.fn((_path: string) => {
      const confirmation = deferred<boolean>();
      confirmations.push(confirmation);
      return confirmation.promise;
    }),
    cancel: vi.fn(() => { confirmations.at(-1)?.resolve(false); }),
    dispose: vi.fn(),
  };
  const createDialog = vi.fn(() => dialog);
  const container = {};
  const actions = {
    snapshot: vi.fn(() => state.snapshot),
    configure: vi.fn(async (_preferences: Record<string, unknown>) => ({ ok: true })),
  };
  const gate = createMacCollectionConsent({ actions, container, createDialog });
  return { state, actions, gate, dialog, createDialog, container, confirmations };
}

const enablingPreferences = () => ({
  enabled: true,
  modelProfileId: "selected-profile",
  processingPaused: true,
  excludedApplications: ["Notes"],
});

describe("Mac collection consent", () => {
  test("creates the dialog lazily and waits for consent before forwarding exact preferences", async () => {
    const h = consentHarness();
    const preferences = enablingPreferences();
    expect(h.createDialog).not.toHaveBeenCalled();

    const configure = h.gate.configure(preferences);

    expect(h.createDialog).toHaveBeenCalledExactlyOnceWith({ container: h.container });
    expect(h.dialog.confirm).toHaveBeenCalledExactlyOnceWith("/fixture/alice/.abot/host-companion/runtime/node");
    expect(h.actions.configure).not.toHaveBeenCalled();
    h.confirmations[0].resolve(true);
    await configure;

    expect(h.actions.configure).toHaveBeenCalledOnce();
    expect(h.actions.configure.mock.calls[0][0]).toBe(preferences);
  });

  test("an initially disconnected paired Mac still asks for consent and preserves start behavior", async () => {
    const h = consentHarness();
    h.state.snapshot.hostConnection.connected = false;
    const preferences = enablingPreferences();

    const configure = h.gate.configure(preferences);

    expect(h.dialog.confirm).toHaveBeenCalledOnce();
    expect(h.actions.configure).not.toHaveBeenCalled();
    h.confirmations[0].resolve(true);
    await configure;

    expect(h.actions.configure.mock.calls[0][0]).toBe(preferences);
  });

  test("cancelling the dialog does not change collection preferences", async () => {
    const h = consentHarness();
    const configure = h.gate.configure(enablingPreferences());

    h.confirmations[0].resolve(false);
    await configure;

    expect(h.actions.configure).not.toHaveBeenCalled();
  });

  test("duplicate enable requests cannot create another dialog or API call", async () => {
    const h = consentHarness();
    const preferences = enablingPreferences();
    const configure = h.gate.configure(preferences);

    expect(await h.gate.configure({ enabled: true, modelProfileId: "duplicate" })).toBeUndefined();
    expect(h.dialog.confirm).toHaveBeenCalledOnce();
    expect(h.actions.configure).not.toHaveBeenCalled();
    h.confirmations[0].resolve(true);
    await configure;

    expect(h.actions.configure).toHaveBeenCalledOnce();
    expect(h.actions.configure.mock.calls[0][0]).toBe(preferences);
  });

  test("explicit cancellation releases the pending request and a later enable asks again", async () => {
    const h = consentHarness();
    const cancelled = h.gate.configure(enablingPreferences());
    h.gate.cancel();
    await cancelled;

    expect(h.dialog.cancel).toHaveBeenCalledOnce();
    expect(h.actions.configure).not.toHaveBeenCalled();

    const next = h.gate.configure(enablingPreferences());
    expect(h.dialog.confirm).toHaveBeenCalledTimes(2);
    h.confirmations[1].resolve(true);
    await next;
    expect(h.actions.configure).toHaveBeenCalledOnce();
  });

  test("an active save prevents opening consent or issuing another API request", async () => {
    const h = consentHarness();
    h.state.snapshot.saving = true;

    await h.gate.configure(enablingPreferences());

    expect(h.createDialog).not.toHaveBeenCalled();
    expect(h.actions.configure).not.toHaveBeenCalled();
  });

  test("consent is requested again after collection has been stopped", async () => {
    const h = consentHarness();
    const first = h.gate.configure(enablingPreferences());
    h.confirmations[0].resolve(true);
    await first;
    h.state.snapshot.status.preferences.enabled = true;

    const stopPreferences = { enabled: false };
    await h.gate.configure(stopPreferences);
    expect(h.actions.configure.mock.calls[1][0]).toBe(stopPreferences);
    h.state.snapshot.status.preferences.enabled = false;

    const second = h.gate.configure(enablingPreferences());
    expect(h.dialog.confirm).toHaveBeenCalledTimes(2);
    h.confirmations[1].resolve(true);
    await second;
    expect(h.actions.configure).toHaveBeenCalledTimes(3);
  });

  test.each([
    ["Windows", (snapshot: ConsentSnapshot) => { snapshot.hostConnection.identity.os = "windows"; }],
    ["Linux", (snapshot: ConsentSnapshot) => { snapshot.hostConnection.identity.os = "linux"; }],
    ["unpaired Mac", (snapshot: ConsentSnapshot) => { snapshot.hostConnection.paired = false; }],
    ["old Mac companion", (snapshot: ConsentSnapshot) => { snapshot.hostConnection.companion = { installedVersion: 5 }; }],
    ["unknown companion version", (snapshot: ConsentSnapshot) => { snapshot.hostConnection.companion = {}; }],
    ["missing companion", (snapshot: ConsentSnapshot) => { delete snapshot.hostConnection.companion; }],
    ["already collecting", (snapshot: ConsentSnapshot) => { snapshot.status.preferences.enabled = true; }],
  ])("forwards %s enable requests immediately without creating a dialog", async (_name, changeSnapshot) => {
    const h = consentHarness();
    changeSnapshot(h.state.snapshot);
    const preferences = enablingPreferences();

    const configure = h.gate.configure(preferences);

    expect(h.actions.configure).toHaveBeenCalledOnce();
    expect(h.actions.configure.mock.calls[0][0]).toBe(preferences);
    expect(h.createDialog).not.toHaveBeenCalled();
    await configure;
  });

  test.each([
    ["collection stop", { enabled: false }],
    ["processing resume", { processingPaused: false }],
    ["processing pause", { processingPaused: true }],
    ["model selection", { modelProfileId: "another-profile" }],
  ])("forwards %s preferences immediately without a dialog", async (_name, preferences) => {
    const h = consentHarness();

    const configure = h.gate.configure(preferences);

    expect(h.actions.configure).toHaveBeenCalledOnce();
    expect(h.actions.configure.mock.calls[0][0]).toBe(preferences);
    expect(h.createDialog).not.toHaveBeenCalled();
    await configure;
  });
});

const changedConsentContexts: [string, (snapshot: ConsentSnapshot) => void][] = [
  ["environment", (snapshot) => { snapshot.environmentId = "production"; }],
  ["host", (snapshot) => { snapshot.hostConnection.hostId = "mac-two"; }],
  ["pairing", (snapshot) => { snapshot.hostConnection.paired = false; }],
  ["connection", (snapshot) => { snapshot.hostConnection.connected = false; }],
  ["connection identity", (snapshot) => { snapshot.hostConnection.connectionId = "connection-two"; }],
  ["OS identity", (snapshot) => { snapshot.hostConnection.identity.os = "linux"; }],
  ["home directory", (snapshot) => { snapshot.hostConnection.identity.homeDir = "/fixture/bob"; }],
  ["companion version", (snapshot) => { snapshot.hostConnection.companion = { installedVersion: 7 }; }],
];

describe("Mac consent context binding", () => {
  test.each(changedConsentContexts)("a changed %s cancels visible consent and skips the API", async (_name, changeSnapshot) => {
    const h = consentHarness();
    const configure = h.gate.configure(enablingPreferences());

    changeSnapshot(h.state.snapshot);
    h.gate.update(h.state.snapshot);
    expect(h.dialog.cancel).toHaveBeenCalledOnce();
    await configure;

    expect(h.actions.configure).not.toHaveBeenCalled();
  });

  test.each(changedConsentContexts)("a changed %s is checked again before applying confirmed consent", async (_name, changeSnapshot) => {
    const h = consentHarness();
    const configure = h.gate.configure(enablingPreferences());

    changeSnapshot(h.state.snapshot);
    h.confirmations[0].resolve(true);
    await configure;

    expect(h.actions.configure).not.toHaveBeenCalled();
  });

  test("an equivalent refreshed snapshot leaves pending consent usable", async () => {
    const h = consentHarness();
    const preferences = enablingPreferences();
    const configure = h.gate.configure(preferences);

    h.state.snapshot = managedMacSnapshot();
    h.gate.update(h.state.snapshot);
    expect(h.dialog.cancel).not.toHaveBeenCalled();
    h.confirmations[0].resolve(true);
    await configure;

    expect(h.actions.configure.mock.calls[0][0]).toBe(preferences);
  });

  test("a late confirmation after cancellation cannot apply to a replacement request", async () => {
    const h = consentHarness();
    h.dialog.cancel.mockImplementationOnce(() => {});
    const stale = h.gate.configure(enablingPreferences());
    h.gate.cancel();
    const preferences = { enabled: true, modelProfileId: "new-choice" };
    const current = h.gate.configure(preferences);

    h.confirmations[0].resolve(true);
    await stale;
    expect(h.actions.configure).not.toHaveBeenCalled();

    h.confirmations[1].resolve(true);
    await current;
    expect(h.actions.configure).toHaveBeenCalledOnce();
    expect(h.actions.configure.mock.calls[0][0]).toBe(preferences);
  });
});

