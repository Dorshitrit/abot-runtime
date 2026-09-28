import type { ToolImplementationOutput } from "../plugin-contract/index.js";
import type { SystemTargetId } from "./contracts.js";
import type { HostOperation, HostStatus } from "./companion/protocol.js";

/** A connection bound to one installation and one accepted host session. */
export type ComputerAccessConnection = Readonly<{
  readHostStatus(rootDir: string): Promise<HostStatus>;
  executeHostOperation(
    rootDir: string,
    input: Readonly<{
      hostId: string;
      connectionId: string;
      operation: HostOperation;
      params: Record<string, unknown>;
      abortSignal?: AbortSignal;
    }>,
  ): Promise<ToolImplementationOutput>;
}>;

export type CompanionTarget = Readonly<{
  hostId: string;
  connectionId: string;
  target: SystemTargetId;
}>;
