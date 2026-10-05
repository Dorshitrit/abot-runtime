import { expect, test, vi } from "vitest";
import { createSuperCompactionSourceFixture } from "./support/super-compaction-source.js";
vi.mock("../model/invoke-raw-step.js", async (load) => ({
  ...(await load<object>()),
  invokeRepairableRawModelStep: async (params: {
    messages: readonly import("../../model-gateway/types.js").ChatMessage[];
    contextCompaction: import("../model/model-step-port.js").ModelStepContextCompactionController;
  }) => params.contextCompaction.getStages()[0]!.prepare(params.messages),
}));

test.each(["payload-first", "worker-first"])(
  "A1/A2 retains one execution source across %s provider failures",
  async (order) => {
    const { request, worker, payload, invoke } =
      await createSuperCompactionSourceFixture();
    const runWorker = () =>
      expect(worker()).rejects.toThrow("fixture_compactor_failure");
    if (order === "payload-first") {
      await payload();
      await runWorker();
    } else {
      await runWorker();
      await payload();
    }
    expect(invoke).toHaveBeenCalledTimes(2);
    const snapshot = request.contextCompactionStore!.snapshot!();
    expect(snapshot.checkpoints).toHaveLength(0);
    expect(snapshot.sources).toHaveLength(1);
    expect(snapshot.sources[0]?.sourceRef).toBe("capability-execution-1");
    expect(JSON.parse(snapshot.sources[0]!.content)).not.toHaveProperty(
      "referenceData",
    );
  },
);
