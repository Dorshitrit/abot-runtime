import {
  failureResult,
  successResult,
  type ToolExecutionContext,
  type ToolImplementation,
} from "../../../../src/plugin-sdk/index.js";
import { SystemOperationError } from "../../../../src/plugin-sdk/computer-access.js";
import { computerFields, readPhysicalRectangle } from "../../../../src/plugin-sdk/computer-access.js";
import { readPublicComputerAction } from "./public-action.js";
import { withDesktopQueue } from "../../../../src/plugin-sdk/computer-access.js";
import { serializeComputerDesktops } from "./observation-output.js";
import {
  describeDesktop,
  projectComputerResult,
} from "./observation-result.js";
import {
  RequestComputers,
  computerQueueIdentity,
  computerRouteLabel,
} from "./request-computers.js";

export const COMPUTER_TOOLS = [
  "computer_desktops",
  "computer_observe",
  "computer_act",
] as const;
export function isComputerTool(name: string): boolean {
  return COMPUTER_TOOLS.some((tool) => tool === name);
}

export function createComputerHandlers(
  computers: RequestComputers,
): Record<string, ToolImplementation> {
  let registered = false;
  const guard =
    (handler: ToolImplementation): ToolImplementation =>
    async (params, context) => {
      try {
        if (!context?.onRequestDispose)
          throw new SystemOperationError(
            "computer_lifecycle_unavailable",
            "Computer control requires request resource cleanup support.",
          );
        if (!registered) {
          context.onRequestDispose(() => computers.close());
          registered = true;
        }
        context.abortSignal?.throwIfAborted();
        return await handler(params, context);
      } catch (error) {
        return failureResult({
          errorCode:
            error instanceof SystemOperationError
              ? error.code
              : "computer_operation_interrupted",
          message:
            error instanceof Error
              ? error.message
              : "Computer operation interrupted; effects may be partial. Observe before another action.",
        });
      }
    };
  return {
    computer_desktops: guard(async (params, context) => {
      computerFields(params, []);
      const desktops = [];
      for (const entry of computers.entries) {
        const observation = await withDesktopQueue(
          computerQueueIdentity(entry),
          context?.abortSignal,
          async () => {
            try {
              entry.bindings.clear();
              const result = await computers
                .backend(entry)
                .execute({ operation: "inspect" }, context?.abortSignal);
              return describeDesktop(entry, result);
            } catch (error) {
              return {
                ...computerRouteLabel(entry),
                available: false,
                reason:
                  error instanceof Error
                    ? error.message
                    : "Desktop inspection failed.",
              };
            }
          },
        );
        desktops.push(observation);
      }
      return successResult({
        output: serializeComputerDesktops(desktops),
        data: {
          desktopCount: desktops.length,
          observationMeta: { kind: "volatile_external", carryPolicy: "never" },
        },
      });
    }),
    computer_observe: guard(async (params, context) => {
      computerFields(params, [
        "desktop_ref",
        "observation_ref",
        "x",
        "y",
        "width",
        "height",
      ]);
      const entry = computers.require(params.desktop_ref);
      requireMedia(context);
      return withDesktopQueue(
        computerQueueIdentity(entry),
        context?.abortSignal,
        async () => {
          const request =
            params.observation_ref === undefined
              ? { operation: "observe" as const }
              : entry.bindings.regionalObservation(
                  params.observation_ref,
                  readPhysicalRectangle({
                    x: params.x,
                    y: params.y,
                    width: params.width,
                    height: params.height,
                  }),
                );
          entry.bindings.clear();
          const result = await computers
            .backend(entry)
            .execute(request, context?.abortSignal);
          return projectComputerResult(entry, result, context!);
        },
      );
    }),
    computer_act: guard(async (params, context) => {
      const action = readPublicComputerAction(params);
      const entry = computers.require(params.desktop_ref);
      requireMedia(context);
      return withDesktopQueue(
        computerQueueIdentity(entry),
        context?.abortSignal,
        async () => {
          const request = entry.bindings.action(params.observation_ref, action);
          const result = await computers
            .backend(entry)
            .execute(request, context?.abortSignal);
          return projectComputerResult(entry, result, context!);
        },
      );
    }),
  };
}

function requireMedia(context: ToolExecutionContext | undefined): void {
  if (!context?.media)
    throw new SystemOperationError(
      "computer_media_unavailable",
      "The runtime does not support temporary tool images.",
    );
}
