import { describe, expect, test } from "vitest";
import { buildToolCompletedEventMetadata } from "../../capabilities/tool-event-metadata.js";
import { titleCaseEventValue } from "../../web-ui/app/lib/event-presentation.js";
import { projectToolActivityEvent } from "../../web-ui/app/lib/tool-activity-event.js";
import { buildConversationToolActions } from "../../web-ui/app/lib/tool-activity-model.js";
import {
  observedProcessResult,
  systemDisplayDefinition,
  systemDisplayEvents,
} from "./support/system-tool-display-fixture.js";

function action(events: Record<string, unknown>[]) {
  return buildConversationToolActions({
    requestId: "display-request",
    events,
    streaming: false,
  })[0]!;
}

describe("system manifest to recorded client activity", () => {
  test.each(["windows", "linux", "macos"])(
    "displays declared target and full command/cwd for %s without interpreting intent",
    (target) => {
      const command = ` \n${"x".repeat(4_092)}\n `;
      const cwd = `/${"p".repeat(4_095)}`;
      const events = systemDisplayEvents({ target, command, cwd });
      const sent = projectToolActivityEvent(events[0]!)!;
      expect(sent.target).toBe(target);
      expect(sent.sent).toContainEqual({ label: "Command", value: command });
      expect(sent.sent).toContainEqual({
        label: "Working directory",
        value: cwd,
      });
      const result = action(events);
      expect(result.sent).toEqual(sent.sent);
      expect(result.intent).toBe("Model-authored rationale");
      expect(result.received).toContainEqual({
        label: "Exit code",
        value: "0",
      });
      expect(result.received).toContainEqual({
        label: "Independent outcome check",
        value: titleCaseEventValue("not_performed"),
      });
      expect(result.received).toContainEqual({
        label: "Evidence scope",
        value: titleCaseEventValue("command_process_completion"),
      });
      expect(result.preview).toContain("Observed native response");
    },
  );

  test("completion metadata does not mutate canonical command/result evidence", () => {
    const call = {
      tool: "system_command",
      params: { command: " pwd ", cwd: "/tmp", target: "linux" },
    };
    const result = observedProcessResult();
    const before = JSON.stringify({ call, result });
    buildToolCompletedEventMetadata(call, result, systemDisplayDefinition());
    expect(JSON.stringify({ call, result })).toBe(before);
  });

  test("the actual failed-process sequence retains signed exit and returned evidence", () => {
    // The native adapter emits tool.completed with ok:false for a settled failure.
    const events = systemDisplayEvents({ result: observedProcessResult(-1) });
    expect(events[1]).toMatchObject({ ok: false });
    const result = action(events);
    expect(result.status).toBe("failed");
    expect(result.received).toContainEqual({ label: "Exit code", value: "-1" });
    expect(result.preview).toContain("Observed native response");
  });

  test("terminal tool.failed evidence and clipping survive projection and lifecycle merge", () => {
    const events = systemDisplayEvents();
    const failure = {
      ...events[1],
      name: "tool.failed",
      ok: false,
      meta: {
        ...events[1]!.meta,
        exitCode: 3,
        outputPreview: "recorded failure",
        outputPreviewTruncated: true,
        outputTruncated: true,
        errorCode: "process_failed",
      },
    };
    const result = action([events[0]!, failure]);
    expect(result).toMatchObject({
      status: "failed",
      preview: "recorded failure",
      previewTruncated: true,
      partial: true,
    });
    expect(result.received).toContainEqual({ label: "Exit code", value: "3" });
  });

  test("before-execution rejection shows prepared command without implying a process ran", () => {
    const started = systemDisplayEvents()[0]!;
    const result = action([
      {
        ...started,
        name: "tool.failed",
        stage: "before_external_execution",
        error: "Approval rejected",
      },
    ]);
    expect(result.executed).toBe(false);
    expect(result.received.some((field) => field.label === "Exit code")).toBe(
      false,
    );
    expect(result.sent.some((field) => field.label === "Command")).toBe(true);
  });

  test("rejected read input retains requested ranges without inventing result windows", () => {
    const display = projectToolActivityEvent({
      name: "tool.failed",
      tool: "read_file",
      stage: "before_external_execution",
      meta: { path: "/tmp/demo.txt", startLine: 10, endLine: 20, startChar: 7 },
    })!;
    expect(display.sent).toContainEqual({
      label: "Requested lines",
      value: "10–20",
    });
    expect(display.sent).toContainEqual({
      label: "Requested character offset",
      value: "7",
    });
    expect(display.received.some((field) => field.label === "Read lines")).toBe(
      false,
    );
  });

  test.each([true, false])(
    "captured elevation=%s is visible without changing execution",
    (elevated) => {
      const result = action(
        systemDisplayEvents({
          params: {
            target: "windows",
            command: "Get-Command ExampleApp",
            cwd: "C:/",
            elevated,
          },
        }),
      );
      expect(result.sent).toContainEqual({
        label: "Elevated",
        value: elevated ? "Yes" : "No",
      });
    },
  );

  test("replay and reordered overlapping events retain the same input/output pairing", () => {
    const events = systemDisplayEvents();
    const replay = JSON.parse(JSON.stringify(events));
    expect(action([replay[1], replay[0], replay[1]])).toEqual(action(events));
  });

  test("result previews remain bounded and clipping is separate from source truncation", () => {
    const execution = { ...observedProcessResult(), output: "x".repeat(2_000) };
    const result = action(systemDisplayEvents({ result: execution }));
    expect(result.preview).toHaveLength(1_200);
    expect(result.previewTruncated).toBe(true);
    expect(result.partial).toBe(false);
  });

  test("target and application catalog operations expose recorded observations", () => {
    const result = {
      ...observedProcessResult(),
      output: "Observed target list",
      data: { availabilityScope: "command_execution_only" },
    };
    const targets = action(
      systemDisplayEvents({ tool: "system_targets", params: {}, result }),
    );
    expect(targets.preview).toBe("Observed target list");
    expect(targets.received).toContainEqual({
      label: "Availability scope",
      value: titleCaseEventValue("command_execution_only"),
    });
    const apps = action(
      systemDisplayEvents({
        tool: "system_applications",
        params: { target: "windows", query: "Example" },
        result: {
          ...result,
          output: "Empty declared catalog",
          data: {
            transport: "wsl_interop",
            observedMatches: 0,
            omittedMatches: 0,
            catalogComplete: true,
            absenceConclusionSupported: false,
          },
        },
      }),
    );
    expect(apps.target).toBe("windows");
    expect(apps.sent).toContainEqual({ label: "Query", value: "Example" });
    expect(apps.received).toContainEqual({
      label: "Catalog matches",
      value: "0",
    });
    expect(apps.received).toContainEqual({
      label: "Absence established",
      value: "No",
    });
  });

  test("launch display retains exact application identity without claiming observed GUI success", () => {
    const appId = "x".repeat(4_096);
    const result = {
      ...observedProcessResult(),
      data: {
        evidenceScope: "launch_request_dispatch",
        independentOutcomeCheck: "not_performed",
      },
    };
    const display = action(
      systemDisplayEvents({
        tool: "system_launch",
        params: {
          target: "windows",
          application_id: appId,
          arguments: ["", " value "],
        },
        result,
      }),
    );
    expect(display.sent).toContainEqual({
      label: "Application ID",
      value: appId,
    });
    expect(display.sent).toContainEqual({
      label: "Arguments",
      value: JSON.stringify(["", " value "]),
    });
    expect(display.received).toContainEqual({
      label: "Evidence scope",
      value: titleCaseEventValue("launch_request_dispatch"),
    });
    expect(display.received).toContainEqual({
      label: "Independent outcome check",
      value: titleCaseEventValue("not_performed"),
    });
  });

  test("long launch argument displays are explicitly marked as excerpts", () => {
    const display = action(
      systemDisplayEvents({
        tool: "system_launch",
        params: {
          target: "macos",
          application_id: "/Applications/Example.app",
          arguments: [" ".repeat(600)],
        },
      }),
    );
    expect(display.sent).toContainEqual({
      label: "Arguments excerpt",
      value: JSON.stringify([" ".repeat(500)]),
    });
    expect(display.sent.some((field) => field.label === "Arguments")).toBe(
      false,
    );
  });

  test("an arbitrary plugin can use the same process fields without a tool-name branch", () => {
    const event = { ...systemDisplayEvents()[1]!, tool: "custom_task_action" };
    const display = projectToolActivityEvent(event)!;
    expect(display.sent).toContainEqual({
      label: "Command",
      value: "Get-Command ExampleApp",
    });
    expect(display.received).toContainEqual({ label: "Exit code", value: "0" });
  });

  test("legacy opaque inputs remain explicitly unrecorded and never become guessed commands", () => {
    const display = projectToolActivityEvent({
      name: "tool.completed",
      tool: "system_command",
      ok: true,
      intent: "Run the application",
      meta: {
        params: { command: "string(len=22)", cwd: "string(len=10)" },
        exitCode: 0,
      },
    })!;
    expect(display.sent).toEqual([
      { label: "Command details", value: "Not recorded in this event" },
    ]);
    expect(display.preview).toBe("");
    expect(display.target).toBe("");
    expect(JSON.stringify(display)).not.toContain("string(len=");
  });
});
