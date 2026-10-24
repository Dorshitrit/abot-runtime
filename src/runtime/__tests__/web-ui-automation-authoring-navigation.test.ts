import { expect, test, vi } from "vitest";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { openAutomationAuthoringChat } from "../../web-ui/app/components/automations/authoring-entry.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function fixture() {
  let workspace = "automations", environment = "prod", current = true;
  const composer = { value: "Unsent text", focus: vi.fn(), dispatchEvent: vi.fn(),
    ownerDocument: { defaultView: { Event: class { constructor(public type: string) {} } } } };
  const start = vi.fn(async ({ canCommit }: { canCommit: () => boolean }) => {
    if (!canCommit()) return false;
    workspace = "chat";
    composer.value = "";
    return true;
  });
  const options = { dom: { composerInput: composer }, shell: { activeWorkspace: () => workspace },
    automationId: "automation-one", revision: 3, startNewConversation: start,
    getEnvironmentId: () => environment, isCurrent: () => current };
  return { composer, start, options, setWorkspace: () => { workspace = "chat"; },
    changeEnvironment: () => { environment = "dev"; }, navigate: () => { current = false; } };
}

test("authoring waits for replacement approval and canonical new-conversation completion", async () => {
  const approval = deferred<boolean>(), started = deferred<boolean>(), f = fixture();
  const start = vi.fn(async ({ canCommit }: { canCommit: () => boolean }) => {
    const accepted = await started.promise;
    if (!accepted || !canCommit()) return false;
    f.setWorkspace();
    f.composer.value = "";
    return true;
  });
  const pending = openAutomationAuthoringChat({ ...f.options, startNewConversation: start,
    confirmReplace: () => approval.promise });
  expect(start).not.toHaveBeenCalled();
  expect(f.composer.value).toBe("Unsent text");
  approval.resolve(true);
  await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
  expect(f.composer.value).toBe("Unsent text");
  started.resolve(true);
  expect(await pending).toBe(true);
  expect(f.composer.dispatchEvent).toHaveBeenCalledOnce();
  expect(f.composer.focus).toHaveBeenCalledOnce();
});

test.each(["cancel", "composer", "environment", "automation"])(
  "authoring does not replace a cancelled or changed %s draft", async (change) => {
    const approval = deferred<boolean>(), f = fixture();
    const pending = openAutomationAuthoringChat({ ...f.options, confirmReplace: () => approval.promise });
    if (change === "composer") f.composer.value = "Newer unsent text";
    if (change === "environment") f.changeEnvironment();
    if (change === "automation") f.navigate();
    approval.resolve(change !== "cancel");
    expect(await pending).toBe(false);
    expect(f.start).not.toHaveBeenCalled();
    expect(f.composer.dispatchEvent).not.toHaveBeenCalled();
  });

test("canonical navigation rechecks the composer guard after its own pending recovery", async () => {
  const navigation = deferred<boolean>(), f = fixture();
  const start = vi.fn(async ({ canCommit }: { canCommit: () => boolean }) => {
    await navigation.promise;
    if (!canCommit()) return false;
    f.setWorkspace();
    return true;
  });
  const pending = openAutomationAuthoringChat({ ...f.options, startNewConversation: start,
    confirmReplace: () => true });
  await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
  f.composer.value = "Typed during recovery";
  navigation.resolve(true);
  expect(await pending).toBe(false);
  expect(f.composer.value).toBe("Typed during recovery");
  expect(f.composer.dispatchEvent).not.toHaveBeenCalled();
});

test("failed or rejected confirmations cannot start a conversation", async () => {
  const f = fixture();
  expect(await openAutomationAuthoringChat({ ...f.options,
    confirmReplace: () => Promise.reject(new Error("Closed")) })).toBe(false);
  expect(f.start).not.toHaveBeenCalled();
  expect(await openAutomationAuthoringChat({ ...f.options,
    confirmReplace: () => true, startNewConversation: async () => false })).toBe(false);
  expect(f.composer.value).toBe("Unsent text");
});
