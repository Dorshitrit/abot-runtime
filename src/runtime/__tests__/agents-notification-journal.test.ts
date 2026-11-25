import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createAgentNotificationJournal } from "../../bridge/agent-notification-journal.js";

const temporary: string[] = [];
afterEach(async () => { for (const directory of temporary.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function fixture() { const path = await mkdtemp(join(tmpdir(), "agent-notification-journal-")); temporary.push(path); return path; }

test("activation persists once, scopes credentials without storing them, and resumes its exact checkpoint", async () => {
  const path = await fixture(), target = ["wss://example.test/bridge", "runtime", "private-token"];
  const first = createAgentNotificationJournal(path, target, () => 1000);
  const initial = await first.read();
  expect(initial.activatedAt).toBe(1000);
  const next = { ...initial, cursor: { attention: [{ agentId: "a", messages: 4, traces: 2 }], waits: [] } };
  await first.write(next);
  expect(await createAgentNotificationJournal(path, target, () => 9999).read()).toEqual(next);
  const directory = join(path, "agents", "notification-delivery"), files = await readdir(directory);
  expect(files).toHaveLength(1);
  expect(await readFile(join(directory, files[0]!), "utf8")).not.toContain("private-token");
  if (process.platform !== "win32") expect((await stat(join(directory, files[0]!))).mode & 0o777).toBe(0o600);
  expect((await createAgentNotificationJournal(path, [...target.slice(0, 2), "replacement-token"], () => 2000).read()).activatedAt).toBe(2000);
});

test("a corrupt checkpoint is retained and rejected rather than silently resetting delivery history", async () => {
  const path = await fixture(), journal = createAgentNotificationJournal(path, ["server", "runtime", "token"], () => 1000);
  await journal.read();
  const directory = join(path, "agents", "notification-delivery"), [filename] = await readdir(directory);
  await writeFile(join(directory, filename!), "{broken", { mode: 0o600 });
  await expect(journal.read()).rejects.toThrow();
  expect(await readFile(join(directory, filename!), "utf8")).toBe("{broken");
});
