import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import type { ResolvedRuntimeToolPath } from "../../../src/plugin-sdk/index.js";
import { MAX_MUTATION_BYTES, type MutationSnapshot, type MutationTargetVersion } from "../../filesystem/source/bounded-io.js";
import { observeFileSlices } from "../../filesystem/source/file-observation.js";
import { fail, FilesystemToolError } from "../../filesystem/source/errors.js";

export function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function versionKey(version: MutationTargetVersion): string {
  return JSON.stringify(version, (_key, value) =>
    typeof value === "bigint" ? value.toString() : value);
}

/** Same safe file observation as SUPER, preserving the UTF-8 BOM as content. */
export async function readSnapshot(target: ResolvedRuntimeToolPath): Promise<MutationSnapshot> {
  try {
    const observed = await observeFileSlices(target, {
      headBytes: MAX_MUTATION_BYTES, tailBytes: 0, maximumFileBytes: MAX_MUTATION_BYTES,
    });
    if (observed.head.includes(0)) fail("binary_file_unsupported", "Expected UTF-8 text.");
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(observed.head);
    } catch {
      fail("filesystem_invalid_encoding", "Expected valid UTF-8 text.");
    }
    return { content, version: { kind: "file", ...observed.metadata, digest: digest(observed.head) } };
  } catch (error) {
    if (error instanceof FilesystemToolError && error.code === "file_not_found") {
      return { content: null, version: { kind: "absent" } };
    }
    throw error;
  }
}

export function lineAt(text: string, offset: number): number {
  return text.slice(0, offset).split("\n").length;
}
