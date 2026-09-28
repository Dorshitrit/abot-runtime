import { readFileSync } from "node:fs";
import {
  buildToolCompletedEventMetadata,
  buildToolStartEventMetadata,
} from "../../../capabilities/tool-event-metadata.js";
import type {
  ToolDefinition,
  ToolExecutionResult,
} from "../../../capabilities/tool-types.js";
import { parseAgentPluginManifest } from "../../plugins/manifest-validator.js";
import { systemProcessResult } from "../../../computer-access/process-result.js";

export function systemDisplayDefinition(
  tool = "system_command",
): ToolDefinition {
  const manifest = parseAgentPluginManifest(
    JSON.parse(readFileSync("plugins/system/plugin.json", "utf8")),
    "system",
  );
  const capability = manifest.extensions["ai.abot.runtime"].capabilities[tool]!;
  return {
    name: tool,
    params: {},
    routingCapability: capability.routingCapability,
    executionEffect: "mixed",
    eventPresentation: capability.eventPresentation,
  };
}

export function observedProcessResult(exitCode = 0): ToolExecutionResult {
  const output = systemProcessResult(
    {
      id: "windows",
      transport: "wsl_interop",
      shell: "/observed/powershell.exe",
    },
    {
      status: "completed",
      exitCode,
      stdout: "Observed native response",
      stderr: "",
      outputTruncated: false,
    },
    "command_process_completion",
  );
  return {
    tool: "system_command",
    progress: false,
    ...output,
  };
}

export function systemDisplayEvents(
  input: {
    command?: string;
    cwd?: string;
    target?: string;
    tool?: string;
    result?: ToolExecutionResult;
    params?: Record<string, unknown>;
  } = {},
) {
  const tool = input.tool ?? "system_command";
  const definition = systemDisplayDefinition(tool);
  const params = input.params ?? {
    command: input.command ?? "Get-Command ExampleApp",
    cwd: input.cwd ?? "C:/Users/example",
    target: input.target ?? "windows",
  };
  const call = { tool, params };
  const result = input.result ?? observedProcessResult();
  const identity = {
    requestId: "display-request",
    executionId: "display-execution",
    tool,
  };
  return [
    {
      ...identity,
      name: "tool.started",
      eventSequence: 1,
      intent: "Model-authored rationale",
      meta: buildToolStartEventMetadata(call, definition),
    },
    {
      ...identity,
      name: "tool.completed",
      eventSequence: 2,
      ok: result.ok,
      meta: buildToolCompletedEventMetadata(call, result, definition),
    },
  ];
}
