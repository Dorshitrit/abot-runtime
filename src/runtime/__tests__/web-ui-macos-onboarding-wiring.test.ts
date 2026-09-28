import { afterEach, expect, test, vi } from "vitest";

const captured = vi.hoisted(() => ({ options: {} as Record<string, any> }));
vi.mock("../../web-ui/app/components/system-host/manager.js", () => ({
  createSystemHostConnectionManager: (options: Record<string, any>) => {
    captured.options = options;
    return {
      state: { snapshot: null },
      markup: () => "",
      setActive: vi.fn(),
      mount: vi.fn(),
      reset: vi.fn(),
      dispose: vi.fn(),
    };
  },
}));

import { createGuideHarness } from "./support/runtime-setup-guide-harness.js";

const disposers: Array<() => void> = [];
afterEach(() => disposers.splice(0).forEach((dispose) => dispose()));

test("the setup guide forwards Mac connection and pairing through its shared Computer step", async () => {
  const connectLocalHost = vi.fn(async () => ({ ok: true }));
  const createHostPairing = vi.fn(async () => ({ code: "A".repeat(43) }));
  const h = createGuideHarness({
    loadHostConnection: vi.fn(async () => ({})),
    connectLocalHost,
    createHostPairing,
  });
  disposers.push(h.guide.dispose);
  expect(connectLocalHost).not.toHaveBeenCalled();
  expect(createHostPairing).not.toHaveBeenCalled();
  await captured.options.connectLocal();
  await captured.options.createPairing();
  expect(connectLocalHost).toHaveBeenCalledOnce();
  expect(createHostPairing).toHaveBeenCalledOnce();
});
