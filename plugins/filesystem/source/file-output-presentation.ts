import { fstatSync } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import type {
  ResolvedRuntimeToolPath,
  ToolExecutionContext,
} from "../../../src/plugin-sdk/index.js";

/** A presentation failure must never change an already committed mutation. */
export function reportCommittedFileOutput(
  context: ToolExecutionContext | undefined,
  target: ResolvedRuntimeToolPath,
  operation: "created" | "updated",
  root: FileHandle,
): void {
  if (!context?.reportFileOutput) return;
  try {
    const identity = fstatSync(root.fd, { bigint: true });
    context.reportFileOutput({
      target,
      operation,
      rootIdentity: {
        device: String(identity.dev),
        inode: String(identity.ino),
        birthtimeNs: String(identity.birthtimeNs),
      },
    });
  } catch {
    // The host may omit the optional card; the filesystem result stays true.
  }
}

/** Called before releasing the mutation root; observers cannot undo a commit. */
export function notifyCommittedFileOutput(
  root: FileHandle,
  onCommitted?: (root: FileHandle) => void,
): void {
  try {
    onCommitted?.(root);
  } catch {
    // The committed tool result is independent of optional presentation.
  }
}
