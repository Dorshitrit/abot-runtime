import { createHash } from "node:crypto";
import {
  mkdir,
  rename,
  rm,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createConversationFileFixture,
  type ConversationFileFixture,
} from "./support/conversation-file-test-fixture.js";

const io = vi.hoisted(() => ({
  beforeOpen: undefined as undefined | (() => Promise<void>),
  afterRead: undefined as undefined | (() => Promise<void>),
  unavailableRootBirth: undefined as undefined | string,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const beforeOpen = io.beforeOpen;
      io.beforeOpen = undefined;
      await beforeOpen?.();
      const handle = await actual.open(...args);
      const read = handle.read.bind(handle);
      handle.read = (async (
        buffer: Buffer,
        offset: number,
        length: number,
        position: number,
      ) => {
        const result = await read(buffer, offset, length, position);
        const afterRead = io.afterRead;
        io.afterRead = undefined;
        await afterRead?.();
        return result;
      }) as FileHandle["read"];
      return handle;
    },
  };
});
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    statSync: (...args: Parameters<typeof actual.statSync>) => {
      const stats = actual.statSync(...args);
      if (String(args[0]) !== io.unavailableRootBirth) return stats;
      if (!stats) return stats;
      return Object.assign(stats, { birthtimeNs: 0n });
    },
  };
});

let fixture: ConversationFileFixture;
beforeEach(async () => {
  fixture = await createConversationFileFixture();
});
afterEach(async () => {
  io.beforeOpen = undefined;
  io.afterRead = undefined;
  io.unavailableRootBirth = undefined;
  await fixture.close();
});

const original = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
const replacement = Buffer.concat([
  original,
  Buffer.from("replacement-secret"),
]);

async function recordFile(location: "agent_work" | "workspace" = "agent_work") {
  const root =
    location === "workspace"
      ? fixture.paths.workspaceDir
      : fixture.paths.agentWorkDir;
  const path = join(root, "file.png");
  await writeFile(path, original);
  await fixture.record(fixture.receipt(path, "created", location));
  return root;
}

async function replaceRoot(root: string, action: "rename" | "delete") {
  if (action === "rename") await rename(root, root + "-previous");
  if (action === "delete") await rm(root, { recursive: true });
  await mkdir(root);
  await writeFile(join(root, "file.png"), replacement);
}

async function expectChangedRoot(response: Response) {
  expect(response.status).toBe(409);
  const body = await response.text();
  expect(body).toContain("conversation_file_root_changed");
  expect(body).not.toContain("replacement-secret");
}

describe("conversation file root instance identity", () => {
  it.each([
    ["agent_work", "rename"],
    ["agent_work", "delete"],
    ["workspace", "rename"],
    ["workspace", "delete"],
  ] as const)(
    "rejects every delivery mode after %s root %s and same-path recreation",
    async (location, action) => {
      const root = await recordFile(location);
      await replaceRoot(root, action);
      await expectChangedRoot(await fixture.read());
      await expectChangedRoot(await fixture.read({ content: "1" }));
      await expectChangedRoot(await fixture.read({ download: "1" }));
    },
  );

  it("preserves access after child creation, removal and a current-content edit", async () => {
    const root = await recordFile();
    await writeFile(join(root, "other.txt"), "child");
    await rm(join(root, "other.txt"));
    await writeFile(join(root, "file.png"), replacement);
    const response = await fixture.read({ download: "1" });
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(replacement);
  });

  it("rejects a historical path-only root hash instead of upgrading its authority", async () => {
    const path = join(fixture.paths.agentWorkDir, "file.png");
    await writeFile(path, original);
    const receipt = fixture.receipt(path);
    const encoded = JSON.stringify([
      "abot-file-output-root-v1",
      "agent_work",
      fixture.paths.agentWorkDir,
    ]);
    const rootId = `sha256:${createHash("sha256").update(encoded, "utf8").digest("hex")}`;
    await fixture.record({ ...receipt, rootId });
    await expectChangedRoot(await fixture.read({ download: "1" }));
  });

  it("does not serve bytes when stable root birth identity is unavailable", async () => {
    io.unavailableRootBirth = await recordFile();
    await expectChangedRoot(await fixture.read({ download: "1" }));
  });

  it("rejects replacement after resolution but before opening the file", async () => {
    const root = await recordFile();
    io.beforeOpen = () => replaceRoot(root, "rename");
    await expectChangedRoot(await fixture.read({ download: "1" }));
  });

  it("rechecks root identity after the file was read", async () => {
    const root = await recordFile();
    io.afterRead = () => replaceRoot(root, "rename");
    await expectChangedRoot(await fixture.read({ download: "1" }));
  });
});
