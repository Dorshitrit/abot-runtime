import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { projectChangesFixture } from "./fixture.js";

describe("project changes Git fixture isolation", () => {
  it("isolates fixture creation and the real reader from ambient user Git configuration", async () => {
    const artifacts = resolve(".codex/artifacts/project-git-diff-20261028/tests");
    await mkdir(artifacts, { recursive: true });
    const home = await mkdtemp(join(artifacts, "ambient-home-"));
    onTestFinished(() => rm(home, { recursive: true, force: true }));
    const configPath = join(home, ".gitconfig");
    const config = '[filter "ambient"]\n\tclean = cat\n';
    await writeFile(configPath, config);
    vi.stubEnv("HOME", home);
    vi.stubEnv("XDG_CONFIG_HOME", join(home, ".config"));
    const fixture = await projectChangesFixture();
    await fixture.write("file.txt", "before\n");
    await fixture.commit();
    await fixture.write("file.txt", "after\n");

    expect(await fixture.service.list("dev", "session-1")).toMatchObject({
      status: "available", additions: 1, deletions: 1,
      files: [expect.objectContaining({ path: "file.txt" })],
    });
    expect(await readFile(configPath, "utf8")).toBe(config);
  });

  it("still rejects filters deliberately configured in the isolated global scope", async () => {
    const fixture = await projectChangesFixture();
    await fixture.write("file.txt", "before\n");
    await fixture.commit();
    const sentinel = join(fixture.root, "FILTER-RAN");
    await fixture.git("config", "--global", "filter.fixture.clean", `touch '${sentinel}'`);
    await fixture.write(".gitattributes", "*.txt filter=fixture\n");
    await fixture.write("file.txt", "after\n");

    expect(await readFile(fixture.globalConfigPath, "utf8")).toContain("filter");
    expect(await fixture.service.list("dev", "session-1")).toMatchObject({
      status: "unavailable", message: expect.stringContaining("filters"),
    });
    await expect(access(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
