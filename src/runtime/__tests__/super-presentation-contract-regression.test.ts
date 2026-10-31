import { expect, test } from "vitest";
import {
  EMPTY_WORKER_CAPABILITY_CONTROLS_SCHEMA,
  type WorkerCapabilityDescriptor,
} from "../orchestration/worker-capabilities/index.js";
import { createWorkerDecisionFormat } from "../steps/worker-decision/format.js";
import { parseWorkerDecisionOutput } from "../steps/worker-decision/parser.js";
import {
  createSupervisorPresentationFormat,
  parseSupervisorPresentationOutput,
} from "../steps/supervisor-decision/presentation.js";

const capabilities = ["first", "second"].map((name): WorkerCapabilityDescriptor => ({
  capabilityId: `fixture.${name}`,
  summary: "Observe an exact target.",
  effect: "observation",
  controls: EMPTY_WORKER_CAPABILITY_CONTROLS_SCHEMA,
}));
type Schema = {
  properties?: Record<string, Schema>;
  anyOf?: Schema[];
  required?: string[];
  enum?: string[];
  items?: Schema;
};

test("SUPER continues requiring client intent for single and batch capability selection", () => {
  const format = createWorkerDecisionFormat({
    capabilities,
    maxBatchCapabilityExecutions: 2,
  });
  const variants = (format.schema as Schema).properties!.decision!.anyOf!;
  const single = variants.find((variant) =>
    variant.properties?.action?.enum?.includes("invoke_capability"));
  const batch = variants.find((variant) =>
    variant.properties?.action?.enum?.includes("invoke_capabilities"));
  expect(single?.required).toContain("intent");
  const item = batch?.properties?.invocations?.items;
  for (const selection of item?.anyOf ?? [item]) {
    expect(selection?.required).toContain("intent");
  }
  const options = {
    availableCapabilities: capabilities,
    maxBatchCapabilityExecutions: 2,
  };
  const first = { capabilityId: capabilities[0]!.capabilityId };
  const second = {
    capabilityId: capabilities[1]!.capabilityId,
    intent: "Observe the second target.",
  };
  for (const decision of [
    { action: "invoke_capability", ...first },
    { action: "invoke_capabilities", invocations: [first, second] },
  ]) {
    const parsed = parseWorkerDecisionOutput(
      JSON.stringify({ decision }), undefined, options,
    );
    expect(parsed).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "worker_capability_intent_invalid" }),
      ]),
    });
  }
  const intent = "Observe the first target.";
  expect(parseWorkerDecisionOutput(JSON.stringify({
    decision: { action: "invoke_capability", ...first, intent },
  }), undefined, options)).toMatchObject({
    ok: true, decision: { intent },
  });
  expect(parseWorkerDecisionOutput(JSON.stringify({
    decision: {
      action: "invoke_capabilities",
      invocations: [{ ...first, intent }, second],
    },
  }), undefined, options)).toMatchObject({
    ok: true, decision: { invocations: [{ ...first, intent }, second] },
  });
});

test("SUPER keeps its required bounded opening acknowledgement and optional title phase", () => {
  const options = { includeAcknowledgement: true, includeTitle: false };
  const format = createSupervisorPresentationFormat(options);
  expect((format.schema as Schema).properties!.decision!.required)
    .toEqual(["acknowledgement"]);
  expect(parseSupervisorPresentationOutput('{"decision":{}}', options))
    .toMatchObject({ ok: false });
  const acknowledgement = "I will inspect the requested targets.";
  expect(parseSupervisorPresentationOutput(JSON.stringify({
    decision: { acknowledgement },
  }), options)).toEqual({ ok: true, decision: { acknowledgement } });
  const titled = { ...options, includeTitle: true };
  expect(parseSupervisorPresentationOutput(JSON.stringify({
    decision: { acknowledgement, title: "Inspect targets" },
  }), titled)).toEqual({
    ok: true, decision: { acknowledgement, title: "Inspect targets" },
  });
});
