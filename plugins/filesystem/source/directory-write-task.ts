export type DirectoryWriteInput = Readonly<{
  relativePath: string;
  content: string;
  expectedVersion:
    | Readonly<{ kind: "absent" }>
    | Readonly<{
        kind: "file";
        device: string;
        inode: string;
        size: number;
        mode: number;
        modifiedNs: string;
        changedNs: string;
        digest: string;
      }>;
}>;

/** Self-contained trusted task: serialized into an isolated Node process. */
export async function commitDirectoryWrite(
  input: DirectoryWriteInput,
): Promise<void> {
  const fs = require("node:fs/promises") as typeof import("node:fs/promises");
  const { constants } = require("node:fs") as typeof import("node:fs");
  const { createHash, randomUUID } =
    require("node:crypto") as typeof import("node:crypto");
  const expected = input.expectedVersion;

  function failWrite(code: string): never {
    throw Object.assign(new Error(code), { code });
  }
  function hasNodeCode(error: unknown, code: string): boolean {
    return error instanceof Error && "code" in error && error.code === code;
  }
  function isSingleComponent(value: string): boolean {
    if (!value || value === "." || value === "..") return false;
    if (value.includes("/") || value.includes("\\")) return false;
    return !value.includes("\0");
  }
  const segments = input.relativePath.split("/");
  if (!segments.every(isSingleComponent)) failWrite("filesystem_path_changed");
  const targetName = segments.pop()!;
  if (Buffer.byteLength(input.content, "utf8") > 1_048_576) {
    failWrite("filesystem_file_too_large");
  }

  async function enterChildDirectory(name: string): Promise<void> {
    let handle: Awaited<ReturnType<typeof fs.open>>;
    const flags =
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
    try {
      handle = await fs.open(name, flags);
    } catch (error) {
      if (!hasNodeCode(error, "ENOENT")) throw error;
      try {
        await fs.mkdir(name);
      } catch (creationError) {
        if (!hasNodeCode(creationError, "EEXIST")) throw creationError;
      }
      handle = await fs.open(name, flags);
    }
    try {
      const held = await handle.stat({ bigint: true });
      if (!held.isDirectory()) failWrite("filesystem_path_changed");
      process.chdir(name);
      const entered = await fs.stat(".", { bigint: true });
      if (held.dev !== entered.dev || held.ino !== entered.ino) {
        failWrite("filesystem_path_changed");
      }
    } finally {
      await handle.close();
    }
  }
  for (const segment of segments) await enterChildDirectory(segment);

  function hasExpectedMetadata(info: import("node:fs").BigIntStats): boolean {
    if (expected.kind !== "file" || !info.isFile()) return false;
    if (String(info.dev) !== expected.device) return false;
    if (String(info.ino) !== expected.inode) return false;
    if (Number(info.size) !== expected.size) return false;
    if ((Number(info.mode) & 0o7777) !== expected.mode) return false;
    if (String(info.mtimeNs) !== expected.modifiedNs) return false;
    return String(info.ctimeNs) === expected.changedNs;
  }
  async function assertExpectedTarget(): Promise<void> {
    let target: Awaited<ReturnType<typeof fs.open>>;
    try {
      target = await fs.open(
        targetName,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch (error) {
      if (hasNodeCode(error, "ENOENT") && expected.kind === "absent") return;
      failWrite("filesystem_target_changed");
    }
    try {
      const before = await target.stat({ bigint: true });
      if (!hasExpectedMetadata(before)) failWrite("filesystem_target_changed");
      if (expected.kind !== "file") failWrite("filesystem_target_changed");
      const bytes = Buffer.alloc(expected.size);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await target.read(
          bytes,
          offset,
          bytes.length - offset,
          offset,
        );
        if (bytesRead <= 0) failWrite("filesystem_target_changed");
        offset += bytesRead;
      }
      const after = await target.stat({ bigint: true });
      if (!hasExpectedMetadata(after)) failWrite("filesystem_target_changed");
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (digest !== expected.digest) failWrite("filesystem_target_changed");
    } finally {
      await target.close();
    }
  }

  const parent = await fs.open(
    ".",
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  const temporaryName = `.abot-${targetName}-${randomUUID()}.tmp`;
  let temporaryCreated = false;
  try {
    const temporary = await fs.open(temporaryName, "wx");
    temporaryCreated = true;
    try {
      await temporary.writeFile(input.content, "utf8");
      if (expected.kind === "file") await temporary.chmod(expected.mode);
      await temporary.sync();
    } finally {
      await temporary.close();
    }
    await assertExpectedTarget();
    if (expected.kind === "file") {
      await fs.rename(temporaryName, targetName);
      temporaryCreated = false;
    } else {
      try {
        await fs.link(temporaryName, targetName);
      } catch (error) {
        if (hasNodeCode(error, "EEXIST"))
          failWrite("filesystem_target_changed");
        throw error;
      }
      const removed = await fs
        .rm(temporaryName, { force: true })
        .then(() => true)
        .catch(() => false);
      temporaryCreated = !removed;
    }
    await parent.sync().catch(() => undefined);
  } finally {
    if (temporaryCreated)
      await fs.rm(temporaryName, { force: true }).catch(() => undefined);
    await parent.close().catch(() => undefined);
  }
}
