import type { ResolvedRuntimeToolPath } from "../../../src/plugin-sdk/index.js";
import {
  DirectoryAuthorityError,
  runDirectoryAuthorityTask,
} from "../../../src/shared/directory-authority/index.js";
import type { MutationTargetVersion } from "./bounded-io.js";
import { fail, rethrowFilesystemError } from "./errors.js";
import { openMutationRoot } from "./mutation-parent.js";
import {
  commitDirectoryWrite,
  type DirectoryWriteInput,
} from "./directory-write-task.js";

export async function writeWithDirectoryAuthority(
  input: Readonly<{
    target: ResolvedRuntimeToolPath;
    content: string;
    expectedVersion: MutationTargetVersion;
  }>,
): Promise<void> {
  const root = await openMutationRoot(input.target);
  const expected = input.expectedVersion;
  const expectedVersion: DirectoryWriteInput["expectedVersion"] =
    expected.kind === "absent"
      ? { kind: "absent" }
      : {
          ...expected,
          device: String(expected.device),
          inode: String(expected.inode),
          modifiedNs: String(expected.modifiedNs),
          changedNs: String(expected.changedNs),
        };
  try {
    await runDirectoryAuthorityTask({
      directoryPath: input.target.rootPath,
      directoryFd: root.fd,
      input: {
        relativePath: input.target.relativePath,
        content: input.content,
        expectedVersion,
      },
      task: commitDirectoryWrite,
    });
  } catch (error) {
    if (error instanceof DirectoryAuthorityError) {
      if (error.code.startsWith("filesystem_")) {
        fail(
          error.code,
          `Safe write failed: ${input.target.logicalPath}`,
          error.data,
        );
      }
      if (error.code.startsWith("directory_authority_")) {
        fail(
          "filesystem_path_changed",
          `Directory authority was lost: ${input.target.logicalPath}`,
        );
      }
    }
    rethrowFilesystemError(error, "write", input.target.logicalPath);
  } finally {
    await root.close().catch(() => undefined);
  }
}
