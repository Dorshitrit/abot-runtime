import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ChatMessage } from "../../model-gateway/types.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { allowsAutomaticPayloadArtifactLoading } from "../request/execution-payload-artifact-policy.js";
import { resolveRequestExecutionPolicy } from "../request/role-executor-composition.js";
import {
  createPayloadArtifactPolicyFixture, CURRENT_TARGET_CONTENT, INCIDENTAL_CONTENT, OBSERVED_CONTENT,
} from "./support/payload-artifact-policy-fixture.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readFile: vi.fn(actual.readFile), stat: vi.fn(actual.stat) };
});

const roots: string[] = [];
beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(async () => {
  resetDebugLoggerConfig();
  vi.clearAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

test.each([false, true])(
  "EA %s: no related-file IO; collected evidence reaches RAW and selected edit target remains available",
  async (staged) => {
    const root = await fixtureRoot();
    const fixture = await createPayloadArtifactPolicyFixture(root, "execution-agent-v1", staged);
    vi.mocked(fs.readFile).mockClear();
    vi.mocked(fs.stat).mockClear();

    expect(await fixture.write()).toMatchObject({ outcome: "succeeded" });

    for (const name of ["needed.txt", "incidental.txt"]) {
      expect(fs.readFile).not.toHaveBeenCalledWith(join(root, name), expect.anything());
      expect(fs.stat).not.toHaveBeenCalledWith(join(root, name));
    }
    const messages = fixture.invoke.mock.calls.flatMap(
      ([input]) => input.messages as ChatMessage[],
    );
    const allText = JSON.stringify(messages);
    expect(allText).toContain(OBSERVED_CONTENT);
    expect(allText).not.toContain(INCIDENTAL_CONTENT);
    expect(allText).not.toContain("DISK_CHANGED_AFTER_OBSERVATION");
    expect(allText).not.toContain("runtime_payload_related_artifact_content_v1");
    const authorContext = messages.map(({ content }) => content)
      .filter((content) => content.startsWith("Canonical runtime context:"))
      .map((content) => JSON.parse(content.slice(content.indexOf("\n") + 1)))
      .find((context) => context.settledCapabilityResults?.length);
    const carried = authorContext.settledCapabilityResults.find(
      (result: { executionId: string }) => result.executionId === "capability-execution-2",
    );
    expect(carried.adapterResult).toEqual(fixture.selectedEvidence.adapterResult);
    expect(fixture.invoke).toHaveBeenCalledTimes(staged ? 2 : 1);
    if (staged) {
      expect(fs.readFile).toHaveBeenCalledWith(join(root, "target.txt"), "utf8");
      expect(allText).toContain("selected target first line");
      expect(allText).toContain("keep this line");
    } else {
      expect(fs.readFile).not.toHaveBeenCalled();
      expect(fs.stat).not.toHaveBeenCalled();
      expect(allText).not.toContain(CURRENT_TARGET_CONTENT);
    }
  },
);

test.each([false, true])(
  "SUPER %s preserves declared related-file loading with the same model and root call shape",
  async (staged) => {
    const root = await fixtureRoot();
    const fixture = await createPayloadArtifactPolicyFixture(root, "supervisor-worker-v1", staged);
    vi.mocked(fs.readFile).mockClear();
    vi.mocked(fs.stat).mockClear();

    expect(await fixture.write()).toMatchObject({ outcome: "succeeded" });

    expect(fs.stat).toHaveBeenCalledWith(join(root, "incidental.txt"));
    expect(fs.readFile).toHaveBeenCalledWith(join(root, "incidental.txt"), "utf8");
    const text = JSON.stringify(fixture.invoke.mock.calls.flatMap(([input]) => input.messages));
    expect(text).toContain(INCIDENTAL_CONTENT);
    expect(text).toContain("DISK_CHANGED_AFTER_OBSERVATION");
    expect(text).toContain("runtime_payload_related_artifact_content_v1");
    if (staged) expect(text).toContain("selected target first line");
  },
);

test("unspecified and SUPER policy preserve the legacy provider behavior", () => {
  expect(allowsAutomaticPayloadArtifactLoading(undefined)).toBe(true);
  expect(allowsAutomaticPayloadArtifactLoading(
    resolveRequestExecutionPolicy("supervisor-worker-v1").authority,
  )).toBe(true);
  expect(allowsAutomaticPayloadArtifactLoading(
    resolveRequestExecutionPolicy("execution-agent-v1").authority,
  )).toBe(false);
});

async function fixtureRoot() {
  const root = await fs.mkdtemp(join(tmpdir(), "artifact-policy-"));
  roots.push(root);
  return root;
}
