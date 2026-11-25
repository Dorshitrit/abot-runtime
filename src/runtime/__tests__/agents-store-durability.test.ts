import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { AgentDefinition } from "../agents/agent-records.js";
import { FileAgentStateStore } from "../agents/file-store.js";

const faults = vi.hoisted(() => ({
  fileSyncTarget: "",
  directorySyncTarget: "",
  afterRenameTarget: "",
  lockReleaseTarget: "",
}));

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const sync = handle.sync.bind(handle);
      vi.spyOn(handle, "sync").mockImplementation(async () => {
        const path = String(args[0]);
        if (faults.fileSyncTarget && path.startsWith(`${faults.fileSyncTarget}.`) && path.endsWith(".tmp"))
          throw new Error("injected_agent_file_sync_failure");
        if (path === faults.directorySyncTarget)
          throw new Error("injected_agent_directory_sync_failure");
        await sync();
      });
      return handle;
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      await actual.rename(...args);
      if (String(args[1]) === faults.afterRenameTarget)
        faults.directorySyncTarget = dirname(String(args[1]));
    },
    unlink: async (...args: Parameters<typeof actual.unlink>) => {
      if (faults.lockReleaseTarget && String(args[0]).startsWith(`${faults.lockReleaseTarget}.lock/`))
        throw new Error("injected_agent_lock_release_failure");
      return actual.unlink(...args);
    },
  };
});

const directories: string[] = [];
afterEach(async () => {
  faults.fileSyncTarget = "";
  faults.directorySyncTarget = "";
  faults.afterRenameTarget = "";
  faults.lockReleaseTarget = "";
  vi.restoreAllMocks();
  for (const directory of directories.splice(0))
    await fs.rm(directory, { recursive: true, force: true });
});

const definition: AgentDefinition = {
  name: "Atlas", icon: "pebble", basePrompt: "Investigate assigned work.",
  modelProfileId: "test-model", executionPolicy: "execution-agent-v1", toolPermissionMode: "ask",
};
const clock = () => "2026-11-17T00:00:00.000Z";

async function fixture() {
  const directory = await fs.mkdtemp(join(tmpdir(), "abot-agents-store-"));
  directories.push(directory);
  const filename = join(directory, "agents", "state.json");
  const fresh = () => new FileAgentStateStore(filename, clock);
  const store = fresh();
  const initial = await store.commit({ kind: "register_agent", agentId: "atlas", definition }, 0);
  return { directory, filename, store, initial, fresh };
}

test("two independent stores serialize CAS and reload the committed identity", async () => {
  const f = await fixture();
  const changes = await Promise.allSettled([
    f.store.commit({ kind: "update_definition", agentId: "atlas", definition: { ...definition, name: "First" } }, 1),
    f.fresh().commit({ kind: "update_definition", agentId: "atlas", definition: { ...definition, name: "Second" } }, 1),
  ]);
  const successes = changes.filter((value) => value.status === "fulfilled");
  const failures = changes.filter((value) => value.status === "rejected");
  expect(successes).toHaveLength(1);
  expect(failures).toHaveLength(1);
  expect(failures[0]).toMatchObject({ reason: { code: "agents_state_revision_conflict" } });
  const saved = await f.fresh().read();
  expect(saved.revision).toBe(2);
  expect(saved.agents[0].id).toBe("atlas");
  expect(saved.changes).toHaveLength(2);
  const returned = saved.agents[0].definition as { name: string };
  returned.name = "Caller modification";
  expect((await f.store.read()).agents[0].definition.name).not.toBe(returned.name);
});

test("file sync failure preserves old bytes and removes only the writer's own temporary file", async () => {
  const f = await fixture();
  const before = await fs.readFile(f.filename, "utf8");
  const unrelated = `${f.filename}.unrelated.tmp`;
  await fs.writeFile(unrelated, "keep");
  faults.fileSyncTarget = f.filename;
  await expect(f.store.commit({ kind: "archive_agent", agentId: "atlas" }, 1))
    .rejects.toThrow("injected_agent_file_sync_failure");
  expect(await fs.readFile(f.filename, "utf8")).toBe(before);
  expect((await fs.readdir(dirname(f.filename))).filter((name) => name.endsWith(".tmp")))
    .toEqual(["state.json.unrelated.tmp"]);
  faults.fileSyncTarget = "";
  expect(await f.store.read()).toEqual(f.initial);
});

test.skipIf(process.platform === "win32")(
  "post-rename failure retains visible state and requires explicit successful reconciliation",
  async () => {
    const f = await fixture();
    faults.afterRenameTarget = f.filename;
    await expect(f.store.commit({ kind: "archive_agent", agentId: "atlas" }, 1))
      .rejects.toMatchObject({ code: "agents_commit_outcome_unknown", targetRevision: 2 });
    expect(JSON.parse(await fs.readFile(f.filename, "utf8"))).toMatchObject({
      revision: 2, agents: [{ status: "archived" }],
    });
    await expect(f.store.read()).rejects.toMatchObject({ code: "agents_state_reconciliation_required" });
    await expect(f.store.commit({ kind: "register_agent", agentId: "other", definition }, 2))
      .rejects.toMatchObject({ code: "agents_state_reconciliation_required" });
    await expect(f.store.reconcile()).rejects.toThrow("injected_agent_directory_sync_failure");
    await expect(f.fresh().read()).rejects.toThrow("injected_agent_directory_sync_failure");
    faults.directorySyncTarget = "";
    faults.afterRenameTarget = "";
    await expect(f.store.read()).rejects.toMatchObject({ code: "agents_state_reconciliation_required" });
    const recovered = await f.store.reconcile();
    expect(recovered.revision).toBe(2);
    expect(await f.fresh().read()).toEqual(recovered);
    await expect(f.store.commit({ kind: "register_agent", agentId: "other", definition }, 1))
      .rejects.toMatchObject({ code: "agents_state_revision_conflict" });
    expect((await f.store.commit({ kind: "register_agent", agentId: "other", definition }, 2)).revision).toBe(3);
  },
);

test.each(["{broken", '{"schemaVersion":999}'])(
  "rejects corrupt or unknown storage without rewriting it (%s)",
  async (content) => {
    const f = await fixture();
    await fs.writeFile(f.filename, content);
    await expect(f.fresh().read()).rejects.toThrow();
    await expect(f.store.commit({ kind: "archive_agent", agentId: "atlas" }, 1)).rejects.toThrow();
    expect(await fs.readFile(f.filename, "utf8")).toBe(content);
  },
);

test("a lock cleanup failure cannot replace the original revision error", async () => {
  const f = await fixture();
  faults.lockReleaseTarget = f.filename;
  await expect(f.store.commit({ kind: "archive_agent", agentId: "atlas" }, 0))
    .rejects.toMatchObject({ code: "agents_state_revision_conflict" });
  expect(JSON.parse(await fs.readFile(f.filename, "utf8"))).toEqual(f.initial);
});
