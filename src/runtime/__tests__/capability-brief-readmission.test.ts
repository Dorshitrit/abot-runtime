import { expect, test, vi } from "vitest";
import type { ToolAvailabilityEntry } from "../../capabilities/tool-types.js";
import type { ChatMessage } from "../../model-gateway/types.js";
import {
  isCapabilityBriefMessage,
  projectCapabilityBriefAtHeadroom,
} from "../context/capability-brief.js";
import {
  createCapabilityBriefReadmissionController,
  type CapabilityBriefReadmissionOptions,
} from "../context/capability-brief-readmission.js";
import type { ModelStepContextCompactionController } from "../model/model-step-port.js";

function createFixture() {
  const entries: ToolAvailabilityEntry[] = ["alpha", "beta"].map((name) => ({
    toolName: name,
    operationId: `${name}_read`,
    summary: `${name} performs bounded observation. `.repeat(30),
    catalogGroups: ["read"],
    effect: "read_only",
  }));
  let options: CapabilityBriefReadmissionOptions = {
    entries,
    groups: [{ groupId: "read", memberCount: 2, effects: ["read_only"] }],
    budget: {
      contextWindowTokens: 32_000,
      outputReserveTokens: 100,
      safetyReserveTokens: 100,
      attachmentReserveTokens: 0,
    },
    format: { schema: { type: "object", required: ["action"] } },
  };
  const initial = projectCapabilityBriefAtHeadroom({
    ...options,
    headroom: 20_000,
  });
  if (!initial.message) throw new Error("fixture_brief_missing");
  const messages: ChatMessage[] = [
    { role: "system", content: "Role instructions." },
    { role: "assistant", content: "Exact previous result." },
    initial.message,
    { role: "user", content: "Current intent." },
  ];
  let scope: ModelStepContextCompactionController["compactionScope"] =
    "session_history";
  const receipt = {
    messages,
    commit: vi.fn(() => {
      scope = "active_request";
    }),
    scopeId: "fixture",
    sourceRevision: 1,
    coveredSourceCount: 0,
  };
  const project = vi.fn((current: readonly ChatMessage[]) => [...current]);
  const prepare = vi.fn(async () => receipt);
  const resolveOptions = vi.fn(() => options);
  const onReadmitted = vi.fn();
  const wrapped = createCapabilityBriefReadmissionController({
    controller: {
      get compactionScope() {
        return scope;
      },
      project,
      prepare,
    },
    resolveOptions,
    onReadmitted,
  });
  return {
    messages,
    project,
    prepare,
    receipt,
    resolveOptions,
    onReadmitted,
    wrapped,
    get options() {
      return options;
    },
    updateOptions(next: Partial<CapabilityBriefReadmissionOptions>) {
      options = { ...options, ...next };
    },
  };
}

test("does not resolve options or inject a brief removed by the base controller", () => {
  const fixture = createFixture();
  const projected = fixture.messages.filter(
    (message) => !isCapabilityBriefMessage(message),
  );
  fixture.project.mockReturnValue(projected);
  fixture.resolveOptions.mockImplementation(() => {
    throw new Error("unexpected_options");
  });
  expect(fixture.wrapped.project(fixture.messages)).toBe(projected);
  expect(fixture.resolveOptions).not.toHaveBeenCalled();
  expect(fixture.onReadmitted).not.toHaveBeenCalled();
});

test("ample headroom returns the exact base projection without notification or mutation", () => {
  const fixture = createFixture();
  const projected = [...fixture.messages];
  fixture.project.mockReturnValue(projected);
  const before = structuredClone({ projected, options: fixture.options });
  expect(fixture.wrapped.project(fixture.messages)).toBe(projected);
  expect(fixture.resolveOptions).toHaveBeenCalledOnce();
  expect(fixture.onReadmitted).not.toHaveBeenCalled();
  expect({ projected, options: fixture.options }).toEqual(before);
});

test("resolves fresh options after projection and preserves every nonbrief at its index", () => {
  const fixture = createFixture();
  const repair: ChatMessage = {
    role: "user",
    content: "Repair invalid output.",
  };
  const projected = [...fixture.messages, repair];
  fixture.project.mockImplementation(() => {
    fixture.updateOptions({
      budget: { ...fixture.options.budget, contextWindowTokens: 1000 },
    });
    return projected;
  });
  const result = fixture.wrapped.project(fixture.messages);
  expect(fixture.project).toHaveBeenCalledExactlyOnceWith(fixture.messages);
  expect(result).not.toBe(projected);
  expect(result.findIndex(isCapabilityBriefMessage)).toBe(2);
  for (const index of [0, 1, 3, 4])
    expect(result[index]).toBe(projected[index]);
  expect(fixture.onReadmitted).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ level: "detailed", reason: "complete_catalog" }),
  );
  expect(result[2]!.content).toContain("alpha_read");
  expect(result[2]!.content).toContain("beta_read");
  expect(result[2]!.content).not.toContain("bounded observation");
});

test("missing canonical entries falls back to complete groups, not a partial operation list", () => {
  const fixture = createFixture();
  fixture.updateOptions({ entries: fixture.options.entries?.slice(0, 1) });
  const result = fixture.wrapped.project(fixture.messages);
  expect(fixture.onReadmitted).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ level: "groups", reason: "complete_catalog" }),
  );
  expect(result[2]!.content).toContain("memberCount=2");
  expect(result[2]!.content).not.toContain("alpha_read");
});

test.each(["additional messages", "schema"] as const)(
  "counts current %s and removes only the optional brief when no level fits",
  (source) => {
    const fixture = createFixture();
    const extra: ChatMessage = { role: "system", content: "x".repeat(4000) };
    fixture.updateOptions({
      budget: { ...fixture.options.budget, contextWindowTokens: 1000 },
      ...(source === "additional messages"
        ? { additionalBudgetMessages: [extra] }
        : { format: { schema: { description: extra.content } } }),
    });
    const before = structuredClone({
      messages: fixture.messages,
      options: fixture.options,
    });
    const result = fixture.wrapped.project(fixture.messages);
    expect(result.some(isCapabilityBriefMessage)).toBe(false);
    expect(result).toEqual(
      fixture.messages.filter((message) => !isCapabilityBriefMessage(message)),
    );
    for (const message of result) expect(fixture.messages).toContain(message);
    expect(result).not.toContain(extra);
    expect(fixture.onReadmitted).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ level: "none", reason: "insufficient_budget" }),
    );
    expect({ messages: fixture.messages, options: fixture.options }).toEqual(
      before,
    );
  },
);

test("delegates prepare receipt and live scope without reading options or committing", async () => {
  const fixture = createFixture();
  expect(fixture.wrapped.compactionScope).toBe("session_history");
  const receipt = await fixture.wrapped.prepare(fixture.messages);
  expect(receipt).toBe(fixture.receipt);
  expect(fixture.prepare).toHaveBeenCalledExactlyOnceWith(fixture.messages);
  expect(fixture.receipt.commit).not.toHaveBeenCalled();
  expect(fixture.resolveOptions).not.toHaveBeenCalled();
  expect(fixture.project).not.toHaveBeenCalled();
  await receipt.commit();
  expect(fixture.wrapped.compactionScope).toBe("active_request");
});
