import { describe, expect, test, vi } from "vitest";
// @ts-expect-error Browser-only module.
import { createCollectionConsentGate } from "../../web-ui/app/components/passive-learning/collection-consent-gate.js";
// @ts-expect-error Browser-only module.
import { activityStatePatch } from "../../web-ui/app/components/passive-learning/activity-controls.js";

function harness(accepted = false, mode = "native") {
  const snapshot = {
    environmentId: "dev", saving: false, loadingStatus: false,
    status: { preferences: { enabled: false, modelProfileId: "learning" }, collectionReason: "" },
    hostConnection: { collectionConsent: { accepted }, collectionSource: { mode, platform: "windows" },
      paired: false, connected: false, readiness: { ready: false } },
  };
  let resolveDialog!: (approved: boolean) => void;
  const dialog = { confirm: vi.fn(() => new Promise<boolean>((resolve) => { resolveDialog = resolve; })),
    cancel: vi.fn(() => resolveDialog?.(false)) };
  const actions = {
    snapshot: () => snapshot,
    refreshCollectionAccess: vi.fn(async (): Promise<unknown> => snapshot.hostConnection),
    acceptCollectionConsent: vi.fn(async (): Promise<unknown> => {
      snapshot.hostConnection.collectionConsent.accepted = true;
      return snapshot.hostConnection;
    }),
    configure: vi.fn(async (preferences: Record<string, unknown>) => ({ preferences: { ...snapshot.status.preferences, ...preferences } })),
    restartCollection: vi.fn(async () => ({ preferences: { enabled: true } })),
  };
  const openComputerAccess = vi.fn();
  const gate = createCollectionConsentGate({ actions, container: {}, openComputerAccess, createDialog: () => dialog });
  return { snapshot, actions, dialog, gate, openComputerAccess,
    async approve(value = true) { await vi.waitFor(() => expect(dialog.confirm).toHaveBeenCalled()); resolveDialog(value); } };
}

describe("installation collection consent", () => {
  test("cancel makes no acknowledgment or preference mutation", async () => {
    const h = harness(), pending = h.gate.configure({ enabled: true });
    await h.approve(false); await pending;
    expect(h.actions.acceptCollectionConsent).not.toHaveBeenCalled();
    expect(h.actions.configure).not.toHaveBeenCalled();
    expect(h.actions.restartCollection).not.toHaveBeenCalled();
  });
  test("native start saves durable acknowledgment before forwarding the exact requested settings", async () => {
    const h = harness(), preferences = { enabled: true, excludedApplications: ["Private app"], processingPaused: true };
    const pending = h.gate.configure(preferences);
    await h.approve(); await pending;
    expect(h.actions.acceptCollectionConsent).toHaveBeenCalledOnce();
    expect(h.actions.configure).toHaveBeenCalledExactlyOnceWith(preferences);
    expect(h.actions.acceptCollectionConsent.mock.invocationCallOrder[0]).toBeLessThan(h.actions.configure.mock.invocationCallOrder[0]!);
    expect(h.openComputerAccess).not.toHaveBeenCalled();
    await h.gate.configure({ enabled: true });
    expect(h.dialog.confirm).toHaveBeenCalledOnce();
    expect(h.actions.acceptCollectionConsent).toHaveBeenCalledOnce();
  });
  test("a consent record saved in another tab skips an obsolete prompt", async () => {
    const h = harness();
    h.actions.refreshCollectionAccess.mockImplementationOnce(async () => {
      h.snapshot.hostConnection.collectionConsent.accepted = true;
      return h.snapshot.hostConnection;
    });
    await h.gate.configure({ enabled: true });
    expect(h.dialog.confirm).not.toHaveBeenCalled();
    expect(h.actions.acceptCollectionConsent).not.toHaveBeenCalled();
    expect(h.actions.configure).toHaveBeenCalledOnce();
  });
  test("a failed authoritative read cannot show a prompt or start collection", async () => {
    const h = harness(); h.actions.refreshCollectionAccess.mockResolvedValueOnce(undefined);
    await h.gate.configure({ enabled: true });
    expect(h.dialog.confirm).not.toHaveBeenCalled();
    expect(h.actions.acceptCollectionConsent).not.toHaveBeenCalled();
    expect(h.actions.configure).not.toHaveBeenCalled();
  });
  test("unpaired companion permission saves keep all settings and do not request pairing or activation", async () => {
    const h = harness(false, "companion");
    const preferences = { activityPermissions: { collection: true, learning: false, proactive: false }, modelProfileId: "new-model" };
    const pending = h.gate.configure(preferences);
    await h.approve(); await pending;
    expect(h.actions.configure).toHaveBeenCalledExactlyOnceWith(preferences);
    expect(h.openComputerAccess).not.toHaveBeenCalled();
    expect(h.actions.restartCollection).not.toHaveBeenCalled();
  });
  test("an unpaired companion start acknowledges first and opens setup without enabling collection", async () => {
    const h = harness(false, "companion"), pending = h.gate.configure({ enabled: true });
    await h.approve(); await pending;
    expect(h.actions.acceptCollectionConsent).toHaveBeenCalledOnce();
    expect(h.openComputerAccess).toHaveBeenCalledOnce();
    expect(h.actions.configure).not.toHaveBeenCalled();
  });
  test("duplicate starts cannot open another prompt or write acknowledgment twice", async () => {
    const h = harness(), pending = h.gate.configure({ enabled: true });
    await h.gate.configure({ enabled: true });
    await h.approve(); await pending;
    expect(h.dialog.confirm).toHaveBeenCalledOnce();
    expect(h.actions.acceptCollectionConsent).toHaveBeenCalledOnce();
  });
  test.each(["environment", "source", "navigation", "saving"])("cancels stale %s consent without changing preferences", async (change) => {
    const h = harness(), pending = h.gate.configure({ enabled: true });
    await vi.waitFor(() => expect(h.dialog.confirm).toHaveBeenCalledOnce());
    if (change === "environment") h.snapshot.environmentId = "prod";
    if (change === "source") h.snapshot.hostConnection.collectionSource.mode = "companion";
    if (change === "saving") h.snapshot.saving = true;
    if (change === "navigation") h.gate.cancel();
    else h.gate.update(h.snapshot);
    await pending;
    expect(h.actions.acceptCollectionConsent).not.toHaveBeenCalled();
    expect(h.actions.configure).not.toHaveBeenCalled();
  });
  test("acknowledgment alone does not restart an already enabled blocked configuration", async () => {
    const h = harness();
    h.snapshot.status.preferences.enabled = true;
    Object.assign(h.snapshot.status.preferences, { activityPermissions: { collection: false, learning: false, proactive: false } });
    h.snapshot.status.collectionReason = "collection_consent_required";
    const preferences = { activityPermissions: { collection: true, learning: false, proactive: false } };
    const pending = h.gate.configure(preferences);
    await h.approve(); await pending;
    expect(h.actions.configure).toHaveBeenCalledExactlyOnceWith(preferences);
    expect(h.actions.restartCollection).not.toHaveBeenCalled();
  });
  test("explicit Start resumes an already enabled configuration blocked on consent", async () => {
    const h = harness(); h.snapshot.status.preferences.enabled = true;
    h.snapshot.status.collectionReason = "collection_consent_required";
    const pending = h.gate.configure({ enabled: true });
    await h.approve(); await pending;
    expect(h.actions.configure).toHaveBeenCalledExactlyOnceWith({ enabled: true });
    expect(h.actions.restartCollection).toHaveBeenCalledOnce();
  });
  test("failed acknowledgment stays closed to collection", async () => {
    const h = harness(); h.actions.acceptCollectionConsent.mockResolvedValueOnce(undefined);
    const pending = h.gate.configure({ enabled: true });
    await h.approve(); await pending;
    expect(h.actions.configure).not.toHaveBeenCalled();
    expect(h.actions.restartCollection).not.toHaveBeenCalled();
  });
  test.each(["environment", "source", "navigation"])("does not restart after %s changes during the requested settings save", async (change) => {
    const h = harness(true); h.snapshot.status.preferences.enabled = true;
    h.snapshot.status.collectionReason = "collection_consent_required";
    let finishSave!: () => void;
    h.actions.configure.mockImplementationOnce(() => new Promise((resolve) => {
      finishSave = () => resolve({ preferences: { ...h.snapshot.status.preferences } });
    }));
    const pending = h.gate.configure({ enabled: true });
    expect(h.actions.configure).toHaveBeenCalledOnce();
    if (change === "environment") h.snapshot.environmentId = "prod";
    if (change === "source") h.snapshot.hostConnection.collectionSource.mode = "companion";
    if (change === "navigation") h.gate.cancel();
    else h.gate.update(h.snapshot);
    finishSave(); await pending;
    expect(h.actions.restartCollection).not.toHaveBeenCalled();
  });
  test("non-collection changes remain independent of the consent gate", async () => {
    const h = harness(); await h.gate.configure({ enabled: false, processingPaused: true });
    expect(h.actions.configure).toHaveBeenCalledOnce();
    expect(h.actions.refreshCollectionAccess).not.toHaveBeenCalled();
    expect(h.dialog.confirm).not.toHaveBeenCalled();
  });
  test.each(["collection", "learning", "proactive"])("legacy Stop %s bypasses awareness without changing other activities", async (activity) => {
    const h = harness(false, "companion");
    Object.assign(h.snapshot.status.preferences, { enabled: true, processingPaused: false, proactiveEnabled: true });
    const preferences = activityStatePatch(activity, h.snapshot.status.preferences, false);
    expect(preferences.activityPermissions.collection).toBe(true);
    await h.gate.configure(preferences);
    expect(h.actions.configure).toHaveBeenCalledExactlyOnceWith(preferences);
    expect(h.actions.refreshCollectionAccess).not.toHaveBeenCalled();
    expect(h.dialog.confirm).not.toHaveBeenCalled();
    expect(h.actions.acceptCollectionConsent).not.toHaveBeenCalled();
    expect(h.openComputerAccess).not.toHaveBeenCalled();
    expect(h.actions.restartCollection).not.toHaveBeenCalled();
  });
  test("Stop dismisses pending awareness and cannot later apply its stale Start", async () => {
    const h = harness(), pending = h.gate.configure({ enabled: true });
    await vi.waitFor(() => expect(h.dialog.confirm).toHaveBeenCalledOnce());
    await h.gate.configure({ enabled: false }); await pending;
    expect(h.dialog.cancel).toHaveBeenCalledOnce();
    expect(h.actions.configure).toHaveBeenCalledExactlyOnceWith({ enabled: false });
    expect(h.actions.acceptCollectionConsent).not.toHaveBeenCalled();
  });
  test("revoking collection permission bypasses awareness", async () => {
    const h = harness(false, "companion"); h.snapshot.status.preferences.enabled = true;
    const preferences = { activityPermissions: { collection: false, learning: true, proactive: true } };
    await h.gate.configure(preferences);
    expect(h.actions.configure).toHaveBeenCalledExactlyOnceWith(preferences);
    expect(h.dialog.confirm).not.toHaveBeenCalled();
    expect(h.actions.refreshCollectionAccess).not.toHaveBeenCalled();
    expect(h.actions.acceptCollectionConsent).not.toHaveBeenCalled();
    expect(h.openComputerAccess).not.toHaveBeenCalled();
  });
});
