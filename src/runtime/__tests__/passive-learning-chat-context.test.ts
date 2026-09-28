import { describe, expect, it } from "vitest";
import { createInMemoryLongTermMemoryRepository } from "../adapters/long-term-memory/in-memory-repository.js";
import { createLongTermMemoryService } from "../long-term-memory/service.js";
import { runRequestRunner } from "../request/runner.js";
import {
  createMemoryRecallHarness,
  modelMessages,
  responseDecision,
  type RecallPolicy,
} from "./support/memory-recall-runner.js";

describe.each<RecallPolicy>(["supervisor-worker-v1", "execution-agent-v1"])(
  "%s learned context",
  (policy) => {
    it("projects source-bearing learned facts only into ordinary response context", async () => {
      const repository = createInMemoryLongTermMemoryRepository({
        schemaVersion: 3, revision: 1,
        records: [{
          id: "mature-memory", content: "Frequently compares TypeScript implementation notes.",
          tags: [], createdAt: "2026-09-23T00:00:00Z", updatedAt: "2026-09-24T00:00:00Z",
          provenance: { kind: "passive_observation", environmentId: "test", deviceId: "desktop",
            batchId: "learning-batch", observationIds: ["observation"], observedAt: "2026-09-23T00:00:00Z",
            reason: "Repeated observed workflow", certainty: "inferred" },
        }],
        vectors: [{ memoryId: "mature-memory", modelFingerprint: "test", dimensions: 2, vector: [1, 0] }],
      });
      const memory = createLongTermMemoryService({
        repository,
        enabled: true,
        emitClientEvents: false,
        embeddings: {
          async embed({ texts }) {
            return {
              modelFingerprint: "test",
              dimensions: 2,
              vectors: texts.map(() => [1, 0]),
            };
          },
        },
      });
      const harness = createMemoryRecallHarness({
        policy,
        retrieve: (input) => memory.retrieve(input),
        decide: () => ({
          ...responseDecision(policy),
          acknowledgement: "I will answer using the relevant context.",
        }),
      });
      await runRequestRunner(harness.request);
      expect(harness.getAdapters).not.toHaveBeenCalled();
      const calls = harness.invoke.mock.calls.map(([input]) => input);
      const root = calls.find(({ modelStep }) =>
        modelStep?.endsWith(".decision"),
      )!;
      expect(JSON.stringify(modelMessages(root))).not.toContain(
        "learning-batch",
      );
      const responses = calls.filter(({ modelStep }) =>
        modelStep?.endsWith(".response"),
      );
      expect(responses.length).toBeGreaterThan(0);
      expect(JSON.stringify(responses)).toContain("passive_observation");
      expect(JSON.stringify(responses)).toContain("inferred");
      expect(JSON.stringify(responses)).not.toContain("learning-batch");
    });
  },
);
