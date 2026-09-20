import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
  symlink,
  link,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureFileOutputRootId,
  readFileOutputRootId,
} from "../capabilities/file-output-root-identity.js";

const io = vi.hoisted(() => ({
  afterRead: undefined as undefined | (() => void),
  beforeCreate: undefined as undefined | (() => void),
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      const flags = args[1];
      if (
        typeof flags === "number" &&
        (flags & actual.constants.O_CREAT) !== 0
      ) {
        const beforeCreate = io.beforeCreate;
        io.beforeCreate = undefined;
        beforeCreate?.();
      }
      return actual.openSync(...args);
    },
    readSync: (...args: Parameters<typeof actual.readSync>) => {
      const length = actual.readSync(...args);
      const afterRead = io.afterRead;
      io.afterRead = undefined;
      afterRead?.();
      return length;
    },
  };
});
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawnSync: (...args: Parameters<typeof actual.spawnSync>) => {
      const beforeCreate = io.beforeCreate;
      io.beforeCreate = undefined;
      beforeCreate?.();
      return actual.spawnSync(...args);
    },
  };
});

let root: string;
let marker: string;
beforeEach(async () => {
  const artifacts = resolve(".codex/artifacts");
  await mkdir(artifacts, { recursive: true });
  root = await mkdtemp(join(artifacts, "root-marker-tests-"));
  marker = join(root, ".abot-file-output-root");
});
afterEach(async () => {
  io.afterRead = undefined;
  io.beforeCreate = undefined;
  await rm(root, { recursive: true, force: true });
});

describe("file output root marker authority", () => {
  it.each(["root", "ancestor"])(
    "does not create a marker outside authority after a %s swap",
    async (target) => {
      const { renameSync, symlinkSync } = await import("node:fs");
      const parent = join(root, "parent");
      const directory = join(parent, "configured");
      const external = join(root, "external");
      const externalDirectory = join(external, "configured");
      await mkdir(directory, { recursive: true });
      await mkdir(externalDirectory, { recursive: true });
      io.beforeCreate = () => {
        if (target === "root") {
          renameSync(directory, directory + "-previous");
          symlinkSync(externalDirectory, directory);
          return;
        }
        renameSync(parent, parent + "-previous");
        symlinkSync(external, parent);
      };
      expect(() => captureFileOutputRootId("agent_work", directory)).toThrow();
      expect(await readdir(externalDirectory)).toEqual([]);
    },
  );

  it("creates a bounded token once and reads without rewriting it", async () => {
    const identity = captureFileOutputRootId("agent_work", root);
    const original = await readFile(marker, "utf8");
    expect(original).toMatch(/^abot-file-output-root-v1\n[a-f0-9]{64}\n$/u);
    expect(captureFileOutputRootId("agent_work", root)).toBe(identity);
    expect(readFileOutputRootId("agent_work", root)).toBe(identity);
    expect(await readFile(marker, "utf8")).toBe(original);
  });

  it("does not create or repair a missing marker while reading", async () => {
    expect(() => readFileOutputRootId("agent_work", root)).toThrow();
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
    const identity = captureFileOutputRootId("agent_work", root);
    await rm(marker);
    expect(() => readFileOutputRootId("agent_work", root)).toThrow();
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
    expect(captureFileOutputRootId("agent_work", root)).not.toBe(identity);
  });

  it.each([
    "user-owned data",
    "x".repeat(1000),
    "abot-file-output-root-v1\ninvalid\n",
  ])(
    "never overwrites a colliding or malformed existing file %#",
    async (contents) => {
      await writeFile(marker, contents);
      expect(() => captureFileOutputRootId("agent_work", root)).toThrow();
      expect(() => readFileOutputRootId("agent_work", root)).toThrow();
      expect(await readFile(marker, "utf8")).toBe(contents);
    },
  );

  it("rejects a marker replaced with a directory", async () => {
    await mkdir(marker);
    expect(() => captureFileOutputRootId("agent_work", root)).toThrow();
    expect(() => readFileOutputRootId("agent_work", root)).toThrow();
  });

  it("rejects high-bit bytes instead of decoding them into valid marker text", async () => {
    const bytes = Buffer.from(
      "abot-file-output-root-v1\n" + "a".repeat(64) + "\n",
    );
    bytes[0] = bytes[0]! | 0x80;
    await writeFile(marker, bytes);
    expect(() => captureFileOutputRootId("agent_work", root)).toThrow();
    expect(() => readFileOutputRootId("agent_work", root)).toThrow();
    expect(await readFile(marker)).toEqual(bytes);
  });

  it("does not follow a marker symlink or overwrite its destination", async () => {
    const external = join(root, "user-file");
    await writeFile(external, "user data");
    await symlink(external, marker);
    expect(() => captureFileOutputRootId("agent_work", root)).toThrow();
    expect(() => readFileOutputRootId("agent_work", root)).toThrow();
    expect(await readFile(external, "utf8")).toBe("user data");
  });

  it("rejects a shared hard-linked marker", async () => {
    captureFileOutputRootId("agent_work", root);
    await link(marker, join(root, "shared-marker"));
    expect(() => readFileOutputRootId("agent_work", root)).toThrow();
    expect(() => captureFileOutputRootId("agent_work", root)).toThrow();
  });

  it("rejects size changes during its bounded read", async () => {
    const { appendFileSync } = await import("node:fs");
    captureFileOutputRootId("agent_work", root);
    io.afterRead = () => appendFileSync(marker, "changed");
    expect(() => readFileOutputRootId("agent_work", root)).toThrow();
  });

  it("rejects a marker leaf replaced during its read", async () => {
    const { renameSync, writeFileSync } = await import("node:fs");
    captureFileOutputRootId("agent_work", root);
    const original = await readFile(marker);
    io.afterRead = () => {
      renameSync(marker, marker + "-previous");
      writeFileSync(marker, original);
    };
    expect(() => readFileOutputRootId("agent_work", root)).toThrow();
  });
});
