import { expect, test, vi } from "vitest";
// @ts-expect-error Browser-only module.
import { prepareSystemWidgetEnvironmentChange } from "../../web-ui/app/components/system-widgets/management-leave.js";

test("existing workspace rejection never asks widgets to discard and accepted guards commit together", async () => {
  const management = vi.fn(() => true);
  expect(await prepareSystemWidgetEnvironmentChange(() => false, management)).toBeNull();
  expect(management).not.toHaveBeenCalled();
  const existingCommit = Object.assign(vi.fn(() => true), { canCommit: () => true });
  const managementCommit = Object.assign(vi.fn(() => true), { canCommit: () => true });
  const commit = await prepareSystemWidgetEnvironmentChange(() => existingCommit, () => managementCommit);
  expect(existingCommit).not.toHaveBeenCalled(); expect(managementCommit).not.toHaveBeenCalled();
  expect(commit.canCommit()).toBe(true); expect(commit()).toBe(true);
  expect(existingCommit).toHaveBeenCalledOnce(); expect(managementCommit).toHaveBeenCalledOnce();
});

test("declined widget leave and stale preparations retain every existing draft", async () => {
  const existing = Object.assign(vi.fn(() => true), { canCommit: () => true });
  expect(await prepareSystemWidgetEnvironmentChange(() => existing, () => false)).toBeNull();
  expect(existing).not.toHaveBeenCalled();
  let current = true;
  const management = Object.assign(vi.fn(() => true), { canCommit: () => current });
  const commit = await prepareSystemWidgetEnvironmentChange(() => existing, () => management);
  current = false;
  expect(commit.canCommit()).toBe(false); expect(commit()).toBe(false);
  expect(existing).not.toHaveBeenCalled(); expect(management).not.toHaveBeenCalled();
});
