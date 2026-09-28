import type { ToolCall } from "../../../../capabilities/tool-types.js";
import type { ToolExecutionOptions, ToolRegistry } from "../../../ports.js";
import type { RequestToolResources } from "../../../capabilities/request-tool-resources.js";
import type { ToolMediaOwner } from "../../../attachments/request-tool-media.js";

/** The admitted call, rather than a tool's arguments, owns every media write. */
export async function executeWithToolResources(params: {
  registry: Pick<ToolRegistry, "execute">;
  call: ToolCall;
  options: ToolExecutionOptions;
  resources?: RequestToolResources;
  owner?: ToolMediaOwner;
}) {
  const execution =
    params.resources && params.owner && params.options.abortSignal
      ? params.resources.media.beginExecution(
          params.owner,
          params.options.abortSignal,
        )
      : undefined;
  try {
    const result = await params.registry.execute(params.call, {
      ...params.options,
      ...(execution ? { media: execution.writer } : {}),
      ...(params.resources
        ? {
            onRequestDispose: params.resources.onRequestDispose,
            requestWork: params.resources.work,
            requestState: params.resources.state,
          }
        : {}),
    });
    if (result.media?.length && !execution)
      throw new Error("tool_media_execution_unbound");
    execution?.finish(result.media);
    return result;
  } catch (error) {
    execution?.finish();
    throw error;
  } finally {
    execution?.close();
  }
}
