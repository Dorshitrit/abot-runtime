import { expect, test, vi } from "vitest";
import * as retention from "../automations/retention.js";
import { createSchedulerRuntimeFixture } from "./support/scheduler-runtime-fixture.js";

test("the production scheduler forwards maintenance to automation retention", async () => {
  const maintain = vi.spyOn(retention, "maintainAutomationRetention").mockResolvedValue(undefined);
  const f = await createSchedulerRuntimeFixture();
  try {
    await f.scheduler.tick();
    expect(maintain).toHaveBeenCalledWith(expect.objectContaining({
      now: expect.any(Number),
      persistence: expect.objectContaining({ read: expect.any(Function), update: expect.any(Function) }),
      results: expect.objectContaining({ read: expect.any(Function) }),
      attachments: expect.objectContaining({ deleteSessionAttachments: expect.any(Function) }),
    }));
  } finally {
    await f.dispose();
    vi.restoreAllMocks();
  }
});
