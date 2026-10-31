import { describe, expect, it, onTestFinished } from "vitest";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { ChatGptStore } from "../account-store.js";
describe("private ChatGPT account storage", () => {
  it("refuses public or symlink account files without reading their contents", async () => {
    const root = resolve(".codex/artifacts/continue-with-chatgpt/store-tests");
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(join(root, "private-"));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const store = new ChatGptStore(directory);
    const initial = await store.read();
    await chmod(join(directory, "accounts.json"), 0o644);
    await expect(store.read()).rejects.toMatchObject({
      code: "chatgpt_store_unavailable",
    });
    await chmod(join(directory, "accounts.json"), 0o600);
    expect((await store.read()).hostId).toBe(initial.hostId);
    const linked = await mkdtemp(join(root, "linked-"));
    onTestFinished(() => rm(linked, { recursive: true, force: true }));
    const target = join(root, "outside-" + Date.now());
    onTestFinished(() => rm(target, { force: true }));
    await writeFile(target, "DO NOT READ");
    await symlink(target, join(linked, "accounts.json"));
    await expect(new ChatGptStore(linked).read()).rejects.toMatchObject({
      code: "chatgpt_store_unavailable",
    });
    expect(await readFile(target, "utf8")).toBe("DO NOT READ");
  });
});
