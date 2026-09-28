import { expect, test, vi } from "vitest";
import type { RuntimeApplication } from "../../composition.js";
import type { LocalRequestControls } from "../../local-host/app-request-control.js";
import { LocalRuntimeOwnerActivity } from "../../local-host/owner-activity.js";
import { SavedRequestApprovals } from "../../local-host/saved-approvals.js";

test("a duplicate request cannot replace the retirement fence of the original activation", async () => {
  const saved = new SavedRequestApprovals(
    { services: { sessions: {} } } as unknown as RuntimeApplication,
    {} as LocalRequestControls,
    new LocalRuntimeOwnerActivity(),
    vi.fn(),
  );
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const original = saved.track("request", () => pending);
  const duplicate = vi.fn(async () => undefined);
  await expect(saved.track("request", duplicate)).rejects.toThrow("local_runtime_request_already_active");
  await expect(saved.track("request", duplicate)).rejects.toThrow("local_runtime_request_already_active");
  expect(duplicate).not.toHaveBeenCalled();
  release();
  await original;
  await expect(saved.track("request", duplicate)).resolves.toBeUndefined();
  expect(duplicate).toHaveBeenCalledOnce();
});
