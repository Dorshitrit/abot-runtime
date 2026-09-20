import { describe, expect, test, vi } from "vitest";
import { buildToolStartEventMetadata } from "../../capabilities/tool-event-metadata.js";
import { createToolApprovalCard } from "../../web-ui/app/components/tool-approval-card.js";
import { projectToolActivityEvent } from "../../web-ui/app/lib/tool-activity-event.js";
import {
  loadConfiguredRuntimePlugins,
  runtimePluginsToToolModules,
} from "../plugins/loader.js";
import { createConfiguredToolRegistry } from "../capabilities/configured-tool-registry.js";
import { loadPublicRuntimeConfig } from "./public-runtime-config-fixture.js";
import { ContextElement } from "./support/composer-context-window-dom.js";
import { createPlanLifecycleHarness } from "./support/web-ui-plan-lifecycle-harness.js";

function fullLengthText(prefix: string): string {
  return prefix + "x".repeat(4096 - prefix.length - 2) + " \t";
}
const command = fullLengthText("  printf '<unsafe>'\n");
const cwd = fullLengthText(" /outside configured roots/project ");
const processId = "exec_" + "p".repeat(123);
const cases: {
  tool: string;
  params: Record<string, string | number>;
  fields: { label: string; value: string }[];
}[] = [
  {
    tool: "exec",
    params: { command, cwd },
    fields: [
      { label: "Command", value: command },
      { label: "Working directory", value: cwd },
    ],
  },
  {
    tool: "exec_wait",
    params: { process_id: processId, cursor: 784321 },
    fields: [
      { label: "Process ID", value: processId },
      { label: "Cursor", value: "784321" },
    ],
  },
  {
    tool: "exec_cancel",
    params: { process_id: processId },
    fields: [{ label: "Process ID", value: processId }],
  },
];

describe("sensitive EXEC exact action approval display", () => {
  test.each(cases)(
    "$tool manifest discloses exact controls through live and replay approval cards",
    async ({ tool, params, fields }) => {
      const config = loadPublicRuntimeConfig(["exec"]);
      const modules = runtimePluginsToToolModules(
        loadConfiguredRuntimePlugins(config),
      );
      const definition = createConfiguredToolRegistry(
        config,
        modules,
      ).getDefinition(tool);
      if (!definition) throw new Error(`Missing registered tool: ${tool}`);
      const meta = buildToolStartEventMetadata({ tool, params }, definition);
      if (tool === "exec") {
        expect(meta).toMatchObject({
          command,
          cwd,
          commandTruncated: false,
          cwdTruncated: false,
        });
        expect(command).toHaveLength(4096);
        expect(cwd).toHaveLength(4096);
      }
      const event = {
        type: "event",
        name: "tool.approval.required",
        requestId: "request-1",
        sessionId: "session-1",
        eventSequence: 9,
        approvalId: "exec-approval",
        recommendedToolPermissionMode: "full_plus",
        tool,
        meta,
      };
      const live = createPlanLifecycleHarness();
      live.realtime.recordEvent(event);
      const replay = createPlanLifecycleHarness({
        sessionId: "session-1",
        messages: [],
        requests: [
          {
            requestId: "request-1",
            status: "running",
            events: [{ ...event, seqNo: 1, timestamp: 1000 }],
          },
        ],
      });
      await replay.conversationSession.openSession("session-1");
      for (const state of [live.state, replay.state]) {
        const projected = state.events[0]!;
        expect(projected.toolActivity).toEqual(
          expect.objectContaining({ sent: fields }),
        );
        const nodes: ContextElement[] = [];
        const onDecision = vi.fn();
        const card = createToolApprovalCard({
          event: projected,
          onDecision,
          documentRoot: {
            createElement: (tag: string) => {
              const node = new ContextElement(tag);
              nodes.push(node);
              return node;
            },
          } as unknown as Document,
        });
        for (const field of fields) {
          expect(nodes.some((node) => node.textContent === field.value)).toBe(
            true,
          );
        }
        if (tool === "exec") {
          expect(card.querySelector("pre")?.textContent).toBe(command);
          expect(card.querySelector("unsafe")).toBeNull();
        }
        expect(onDecision).not.toHaveBeenCalled();
      }
    },
  );

  test("unrelated tools do not gain process controls", () => {
    expect(
      projectToolActivityEvent({
        name: "tool.approval.required",
        tool: "read_file",
        meta: { path: "notes.txt" },
      })?.sent,
    ).toEqual([{ label: "Path", value: "notes.txt" }]);
  });
});
