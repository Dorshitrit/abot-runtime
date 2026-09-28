import { describe, expect, it, vi } from "vitest";
import { systemRequestPluginFixture } from "./support/system-request-plugin-fixture.js";
import { createConfiguredToolRegistry } from "../capabilities/configured-tool-registry.js";
import { restrictToolRegistryToRequestMode } from "../capabilities/request-permission-tool-registry.js";
import { createRegisteredToolNormalInvocationExecutor } from "../adapters/registered-tool-normal-invocations.js";
import { loadPublicRuntimeConfig } from "./public-runtime-config-fixture.js";
import type { ToolApprovalDecision, ToolPermissionMode } from "../ports.js";
import type { ToolNormalInvocationPropertyInput } from "../../capabilities/normal-invocation/contracts.js";
import type { ToolImplementation } from "../../plugin-sdk/index.js";
import { projectToolActivityEvent } from "../../web-ui/app/lib/tool-activity-event.js";
import { createToolApprovalCard } from "../../web-ui/app/components/tool-approval-card.js";
import { ContextElement } from "./support/composer-context-window-dom.js";

async function fixture(mode: ToolPermissionMode) {
  const setup = systemRequestPluginFixture();
  const modules = await setup.prepare([
    "computer_desktops",
    "computer_observe",
    "computer_act",
  ]);
  const dispatch = vi.fn<ToolImplementation>(async () => ({
    ok: true,
    output: "Bound fixture result.",
    producedNewInformation: true,
  }));
  const registry = restrictToolRegistryToRequestMode(
    createConfiguredToolRegistry(
      loadPublicRuntimeConfig(["system"]),
      modules.map((module) => ({ ...module, implementation: dispatch })),
    ),
    mode,
  );
  let decide!: (decision: ToolApprovalDecision) => void;
  const requestToolApproval = vi.fn(
    () =>
      new Promise<ToolApprovalDecision>((resolve) => {
        decide = resolve;
      }),
  );
  const controller = new AbortController();
  const events: Record<string, unknown>[] = [];
  const executor = createRegisteredToolNormalInvocationExecutor({
    registrations: registry.listNormalInvocations!(),
    toolRegistry: registry,
    requestId: "computer-approval",
    toolPermissionMode: mode,
    abortSignal: controller.signal,
    toolApprovalController: { requestToolApproval },
    nextApprovalId: () => "approval",
    onEvent: (name, payload) => events.push({ ...payload, name }),
  });
  return {
    executor,
    dispatch,
    requestToolApproval,
    controller,
    events,
    decide: (decision: ToolApprovalDecision) => decide(decision),
  };
}

function scalarFixture(schema: ToolNormalInvocationPropertyInput): unknown {
  if (schema.type === "string")
    return "enum" in schema ? schema.enum[0] : "observed-reference";
  if (schema.type === "number" || schema.type === "integer")
    return schema.minimum;
  if (schema.type === "array") return ["Enter"];
  return false;
}

describe("computer operations use existing exact-action approvals", () => {
  it.each(["ask", "full_access"] as const)(
    "%s binds each desktop action before approval and never dispatches a rejection",
    async (mode) => {
      const h = await fixture(mode);
      expect(h.executor.operations.length).toBe(10);
      for (const registration of h.executor.operations) {
        const operation = registration.operation;
        expect(operation.approval).toBe("always");
        const controls = Object.fromEntries(
          Object.entries(operation.input.properties).map(([name, schema]) => [
            name,
            scalarFixture(schema),
          ]),
        );
        const pending = h.executor.execute({
          handle: registration.handle,
          controls,
          intent: "Perform the explicitly requested desktop operation.",
        });
        const approval = h.requestToolApproval.mock.calls.at(-1);
        expect(approval).toBeDefined();
        expect(h.dispatch).not.toHaveBeenCalled();
        h.decide({ approved: false });
        expect(await pending).toMatchObject({
          status: "rejected",
          code: "tool_approval_rejected",
        });
      }
      expect(h.dispatch).not.toHaveBeenCalled();
    },
  );
  it("FULL+ dispatches the selected operation with its fixed kind and bound reference", async () => {
    const h = await fixture("full_plus");
    const registration = h.executor.operations.find(
      (entry) => entry.operation.operationId === "computer_press_keys",
    )!;
    const controls = Object.fromEntries(
      Object.entries(registration.operation.input.properties).map(
        ([name, schema]) => [name, scalarFixture(schema)],
      ),
    );
    expect(
      await h.executor.execute({
        handle: registration.handle,
        controls,
        intent: "Press the requested key.",
      }),
    ).toMatchObject({ status: "executed", result: { ok: true } });
    expect(h.requestToolApproval).not.toHaveBeenCalled();
    expect(h.dispatch.mock.calls[0]?.[0]).toMatchObject({
      ...controls,
      action_kind: "press_keys",
    });
  });
  it("rejects a substituted desktop reference before requesting approval", async () => {
    const h = await fixture("ask");
    const registration = h.executor.operations.find(
      (entry) => entry.operation.operationId === "observe_computer_desktop",
    )!;
    expect(
      await h.executor.execute({
        handle: registration.handle,
        controls: { desktop_ref: "different-request" },
        intent: "Read the desktop.",
      }),
    ).toMatchObject({ status: "rejected" });
    expect(h.requestToolApproval).not.toHaveBeenCalled();
    expect(h.dispatch).not.toHaveBeenCalled();
  });
});

const actionDisclosureCases = [
  {
    kind: "click",
    controls: { x: 0, y: 21, button: "right", count: 2 },
    fields: {
      "Image X": "0",
      "Image Y": "21",
      Button: "right",
      "Click count": "2",
    },
  },
  {
    kind: "move",
    controls: { x: 24, y: 99 },
    fields: { "Image X": "24", "Image Y": "99" },
  },
  {
    kind: "drag",
    controls: {
      from_x: 0,
      from_y: 7,
      to_x: 99,
      to_y: 103,
      button: "left",
      duration_ms: 350,
    },
    fields: {
      "From image X": "0",
      "From image Y": "7",
      "To image X": "99",
      "To image Y": "103",
      Button: "left",
      "Duration (ms)": "350",
    },
  },
  {
    kind: "scroll",
    controls: { delta_x: -120, delta_y: 240 },
    fields: { "Horizontal scroll": "-120", "Vertical scroll": "240" },
  },
  {
    kind: "type_text",
    controls: { text: "  <script>literal text</script>\n\t" },
    fields: {
      "Typed text": "  <script>literal text</script>\n\t",
      "Text characters": "33",
    },
  },
  {
    kind: "press_keys",
    controls: { keys: ["Control", "L"] },
    fields: { Keys: '["Control","L"]' },
  },
  {
    kind: "focus_window",
    controls: { window_ref: "window-opaque-ref" },
    fields: { "Window reference": "window-opaque-ref" },
  },
];

describe("prepared computer action disclosure", () => {
  it.each(["ask", "full_access"] as const)(
    "%s exposes every action's exact controls before the decision",
    async (mode) => {
      const h = await fixture(mode);
      for (const { kind, controls, fields } of actionDisclosureCases) {
        const registration = h.executor.operations.find(
          (entry) => entry.operation.operationId === `computer_${kind}`,
        )!;
        const acceptedControls = {
          desktop_ref: scalarFixture(
            registration.operation.input.properties.desktop_ref!,
          ),
          observation_ref: "source-observation",
          ...controls,
        };
        const pending = h.executor.execute({
          handle: registration.handle,
          controls: acceptedControls,
          intent: "Same model rationale for all actions.",
        });
        const event = [...h.events]
          .reverse()
          .find((entry) => entry.name === "tool.approval.required")!;
        expect(event).toBeDefined();
        expect(h.dispatch).not.toHaveBeenCalled();
        const expectedFields = {
          Action: kind,
          "Observation reference": "source-observation",
          ...fields,
        };
        for (const source of [event, JSON.parse(JSON.stringify(event))]) {
          const toolActivity = projectToolActivityEvent(source)!;
          for (const [label, value] of Object.entries(expectedFields)) {
            expect(toolActivity.sent).toContainEqual({ label, value });
          }
          const onDecision = vi.fn();
          const card = createToolApprovalCard({
            event: { ...source, toolActivity },
            onDecision,
            documentRoot: {
              createElement: (tag: string) => new ContextElement(tag),
            } as unknown as Document,
          });
          for (const value of Object.values(expectedFields))
            expect(card.textContent).toContain(value);
          if (kind === "type_text")
            expect(card.querySelector("pre")?.textContent).toBe(controls.text);
          expect(card.querySelector("script")).toBeNull();
          expect(onDecision).not.toHaveBeenCalled();
        }
        h.decide({ approved: false });
        expect(await pending).toMatchObject({
          status: "rejected",
          code: "tool_approval_rejected",
        });
        expect(h.dispatch).not.toHaveBeenCalled();
      }
    },
  );

  it.each(["", " ".repeat(4096)])(
    "discloses empty and maximum-length text without guessing from intent",
    async (text) => {
      const h = await fixture("ask");
      const registration = h.executor.operations.find(
        (entry) => entry.operation.operationId === "computer_type_text",
      )!;
      const pending = h.executor.execute({
        handle: registration.handle,
        controls: {
          desktop_ref: scalarFixture(
            registration.operation.input.properties.desktop_ref!,
          ),
          observation_ref: "source-observation",
          text,
        },
        intent: "This intent must not replace the literal text.",
      });
      const event = [...h.events]
        .reverse()
        .find((entry) => entry.name === "tool.approval.required")!;
      expect(projectToolActivityEvent(event)?.sent).toContainEqual({
        label: "Typed text",
        value: text,
      });
      expect(projectToolActivityEvent(event)?.sent).toContainEqual({
        label: "Text characters",
        value: String(text.length),
      });
      h.decide({ approved: true });
      expect(await pending).toMatchObject({ status: "executed" });
      expect(h.dispatch.mock.calls[0]?.[0]).toMatchObject({
        action_kind: "type_text",
        text,
      });
    },
  );

  it("does not add computer controls to unrelated tool events", () => {
    expect(
      projectToolActivityEvent({
        name: "tool.approval.required",
        tool: "read_file",
        meta: { path: "notes.txt" },
      })?.sent,
    ).toEqual([{ label: "Path", value: "notes.txt" }]);
  });
});
