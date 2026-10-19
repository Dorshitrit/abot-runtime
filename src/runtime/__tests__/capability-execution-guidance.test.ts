import { describe, expect, test, vi } from "vitest";

import {
  buildBatchCapabilityExecutionGuidance,
  type CapabilityExecutionGuidanceEntry,
} from "../steps/capability-execution-guidance.js";
import { buildExecutionControlsRefinementInstructions } from "../steps/execution-agent/refinement-prompt.js";
import { projectWorkerCapabilityExecutionGuidance } from "../steps/worker-decision/input/execution-guidance.js";

function entry(slot: string, capabilityId: string, guidance: string) {
  return Object.freeze({ slot, capabilityId, guidance });
}

function renderSingle(invocation: CapabilityExecutionGuidanceEntry) {
  return [
    `single:${invocation.slot}:${invocation.capabilityId}`,
    invocation.guidance,
  ];
}

function countBody(text: string, body: string): number {
  return text.split(body).length - 1;
}

function applicability(
  lines: readonly string[],
  slot: string,
  capabilityId: string,
) {
  const line = lines.find((value) =>
    value.includes(`${slot} (${capabilityId})`),
  );
  expect(line).toBeDefined();
  return line!;
}

const sharedBody = "  fixture shared guidance\nPreserve the complete body.\n";
const otherBody = "fixture independent guidance";

describe("batch capability execution guidance", () => {
  test("passes unique and empty entries to the caller unchanged and in order", () => {
    const invocations = Object.freeze([
      Object.freeze({
        ...entry("slot_2", "alpha", sharedBody),
        evidenceIds: ["receipt-2"],
      }),
      entry("slot_4", "alpha", ""),
      entry("slot_7", "beta", otherBody),
      entry("slot_9", "alpha", ""),
    ]);
    const before = structuredClone(invocations);
    const render = vi.fn(renderSingle);

    const lines = buildBatchCapabilityExecutionGuidance(invocations, render);

    expect(lines).toEqual(invocations.flatMap(renderSingle));
    expect(render).toHaveBeenCalledTimes(invocations.length);
    invocations.forEach((invocation, index) => {
      expect(render.mock.calls[index]?.[0]).toBe(invocation);
    });
    expect(invocations).toEqual(before);
  });

  test("groups exact bodies across same and different capabilities at first occurrence", () => {
    const invocations = Object.freeze([
      entry("slot_2", "alpha", sharedBody),
      entry("slot_4", "beta", otherBody),
      entry("slot_7", "alpha", sharedBody),
      entry("slot_9", "gamma", sharedBody),
    ]);
    const render = vi.fn(renderSingle);

    const lines = buildBatchCapabilityExecutionGuidance(invocations, render);
    const appliesTo = applicability(lines, "slot_2", "alpha");

    expect(lines.filter((line) => line === sharedBody)).toHaveLength(1);
    expect(appliesTo).toContain("slot_7 (alpha)");
    expect(appliesTo).toContain("slot_9 (gamma)");
    expect(appliesTo).not.toContain("slot_4");
    expect(appliesTo.indexOf("slot_2")).toBeLessThan(
      appliesTo.indexOf("slot_7"),
    );
    expect(appliesTo.indexOf("slot_7")).toBeLessThan(
      appliesTo.indexOf("slot_9"),
    );
    expect(lines.indexOf(sharedBody)).toBeLessThan(lines.indexOf(otherBody));
    expect(render).toHaveBeenCalledExactlyOnceWith(invocations[1]);
  });

  test("does not normalize whitespace or merge partially overlapping whole bodies", () => {
    const invocations = Object.freeze([
      entry("slot_1", "alpha", "# Shared title\ncommon body"),
      entry("slot_2", "alpha", "# Shared title\ncommon body "),
      entry("slot_3", "alpha", " # Shared title\ncommon body"),
      entry(
        "slot_4",
        "beta",
        "# Shared title\ncommon body\nadditional section",
      ),
      entry("slot_5", "beta", " "),
      entry("slot_6", "beta", "\n"),
    ]);
    const render = vi.fn(renderSingle);

    expect(buildBatchCapabilityExecutionGuidance(invocations, render)).toEqual(
      invocations.flatMap(renderSingle),
    );
    expect(render).toHaveBeenCalledTimes(invocations.length);
  });

  test("has no deduplication state between separate invocations", () => {
    const batch = Object.freeze([
      entry("slot_1", "alpha", sharedBody),
      entry("slot_2", "alpha", sharedBody),
    ]);
    const first = buildBatchCapabilityExecutionGuidance(batch, renderSingle);
    expect(buildBatchCapabilityExecutionGuidance(batch, renderSingle)).toEqual(
      first,
    );

    const next = entry("slot_9", "beta", sharedBody);
    expect(buildBatchCapabilityExecutionGuidance([next], renderSingle)).toEqual(
      renderSingle(next),
    );
    const changed = entry("slot_1", "alpha", otherBody);
    expect(
      buildBatchCapabilityExecutionGuidance([changed], renderSingle),
    ).toEqual(renderSingle(changed));
  });

  test("accepts an empty batch without invoking the caller", () => {
    const render = vi.fn(renderSingle);
    expect(buildBatchCapabilityExecutionGuidance([], render)).toEqual([]);
    expect(render).not.toHaveBeenCalled();
  });
});

describe("Execution Agent guidance assembly", () => {
  test("retains sparse original slots and limits shared applicability to matching bodies", () => {
    const pending = Object.freeze([
      entry("invocation_2", "alpha", sharedBody),
      entry("invocation_7", "beta", otherBody),
      entry("invocation_9", "gamma", sharedBody),
    ]);

    const prompt = buildExecutionControlsRefinementInstructions(pending);
    const appliesTo = applicability(
      prompt.split("\n"),
      "invocation_2",
      "alpha",
    );

    expect(countBody(prompt, sharedBody)).toBe(1);
    expect(countBody(prompt, otherBody)).toBe(1);
    expect(appliesTo).toContain("invocation_9 (gamma)");
    expect(appliesTo).not.toContain("invocation_7");
    expect(prompt).toContain("### invocation_7 beta");
    expect(prompt).not.toContain("invocation_1");
  });

  test("preserves the existing single-entry wrapper and repeats guidance on a later call", () => {
    const pending = [entry("invocation_4", "alpha", sharedBody)];
    const prompt = buildExecutionControlsRefinementInstructions(pending);
    const originalBlock = [
      "### invocation_4 alpha",
      sharedBody,
      "### end invocation_4",
    ];

    expect(prompt.endsWith(originalBlock.join("\n"))).toBe(true);
    expect(buildExecutionControlsRefinementInstructions(pending)).toBe(prompt);
  });
});

describe("Worker guidance assembly", () => {
  test("maps a shared batch body to the original schema slots across capabilities", () => {
    const invocations = Object.freeze([
      Object.freeze({
        capabilityId: "alpha",
        intent: "first",
        guidance: sharedBody,
      }),
      Object.freeze({
        capabilityId: "beta",
        intent: "second",
        guidance: otherBody,
      }),
      Object.freeze({
        capabilityId: "gamma",
        intent: "third",
        guidance: sharedBody,
      }),
    ]);
    const options = { selectedCapabilityBatchExecution: { invocations } };
    const before = structuredClone(options);

    const lines = projectWorkerCapabilityExecutionGuidance(options);
    const appliesTo = applicability(lines, "invocation_1", "alpha");

    expect(lines.filter((line) => line === sharedBody)).toHaveLength(1);
    expect(lines.filter((line) => line === otherBody)).toHaveLength(1);
    expect(appliesTo).toContain("invocation_3 (gamma)");
    expect(appliesTo).not.toContain("invocation_2");
    expect(lines).toContain("#### Invocation 2: beta");
    expect(projectWorkerCapabilityExecutionGuidance(options)).toEqual(lines);
    expect(options).toEqual(before);
  });

  test("keeps unique batch bodies and separate empty slots in original order", () => {
    const invocations = [sharedBody, "", otherBody, ""].map(
      (guidance, index) => ({
        capabilityId: `capability_${index + 1}`,
        intent: "fixture intent",
        guidance,
      }),
    );
    const lines = projectWorkerCapabilityExecutionGuidance({
      selectedCapabilityBatchExecution: { invocations },
    });
    const headings = lines.filter((line) =>
      line.startsWith("#### Invocation "),
    );

    expect(headings).toEqual(
      invocations.map(
        ({ capabilityId }, index) =>
          `#### Invocation ${index + 1}: ${capabilityId}`,
      ),
    );
    expect(lines.indexOf(sharedBody)).toBeLessThan(lines.indexOf(otherBody));
    expect(lines[lines.indexOf(headings[1]!) + 1]).toBeTruthy();
    expect(lines[lines.indexOf(headings[3]!) + 1]).toBeTruthy();
  });

  test("preserves single-execution body placement and supplies nothing when unselected", () => {
    const selectedCapabilityExecution = {
      capabilityId: "alpha",
      intent: "fixture intent",
      guidance: sharedBody,
    };
    const lines = projectWorkerCapabilityExecutionGuidance({
      selectedCapabilityExecution,
    });

    expect(lines).toHaveLength(3);
    expect(lines[1]).toBe(sharedBody);
    expect(projectWorkerCapabilityExecutionGuidance({})).toEqual([]);
  });
});
