import { describe, expect, it, vi } from "vitest";
import { access, chmod, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createProjectGitRead, projectGitEnvironment, projectGitExecutable } from "../git-process.js";
import { requireSafeGitConfiguration } from "../repository.js";
import { projectChangesFixture } from "./fixture.js";

describe("bounded read-only Git process", () => {
  it("clears inherited Git authority overrides and forbids transports", () => {
    vi.stubEnv("GIT_DIR", "/outside"); vi.stubEnv("GIT_CONFIG_COUNT", "3"); vi.stubEnv("GIT_EXTERNAL_DIFF", "execute-me");
    try {
      const environment = projectGitEnvironment();
      expect(environment.GIT_DIR).toBeUndefined(); expect(environment.GIT_CONFIG_COUNT).toBeUndefined(); expect(environment.GIT_EXTERNAL_DIFF).toBeUndefined();
      expect(environment).toMatchObject({ GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: "", GIT_NO_LAZY_FETCH: "1" });
    } finally { vi.unstubAllEnvs(); }
  });
  it("bounds timeout, output and pre-aborted requests with fixed shell-free argv", async () => {
    const fixture = await projectChangesFixture();
    const executable = join(fixture.root, "git-fixture");
    await writeFile(executable, `#!${process.execPath}\nif(process.argv.includes('wait')) setTimeout(()=>{},10000); else if(process.argv.includes('large')) process.stdout.write('x'.repeat(2000)); else process.stdout.write(JSON.stringify(process.argv.slice(2)));\n`);
    await chmod(executable, 0o700);
    const read = createProjectGitRead(executable, fixture.root, undefined, { timeoutMs: 100 });
    const result = await read(["literal", "; touch sentinel"]);
    expect(JSON.parse(result.stdout.toString())).toContain("; touch sentinel");
    expect(JSON.parse(result.stdout.toString())).toContain("--no-replace-objects");
    await expect(read(["wait"])).rejects.toMatchObject({ code: "project_changes_unavailable" });
    await expect(read(["large"], { maxBytes: 100 })).rejects.toMatchObject({ code: "project_changes_too_large" });
    await expect(createProjectGitRead(executable, fixture.root, AbortSignal.abort())([])).rejects.toMatchObject({ code: "project_changes_unavailable" });
  });
  it("forbids command transport even when an old Git attempts promisor lazy fetch", async () => {
    const fixture = await projectChangesFixture();
    await fixture.write("file.txt", "baseline\n"); await fixture.commit();
    const oid = (await fixture.git("rev-parse", "HEAD:file.txt")).trim();
    await rm(join(fixture.root, ".git/objects", oid.slice(0, 2), oid.slice(2)));
    const sentinel = join(fixture.root, "TRANSPORT-RAN");
    await fixture.git("config", "remote.origin.promisor", "true");
    await fixture.git("config", "remote.origin.url", `ext::sh -c touch% ${sentinel}`);
    await fixture.git("config", "protocol.ext.allow", "always");
    const result = await createProjectGitRead(await projectGitExecutable(), fixture.root)(["cat-file", "blob", oid]);
    expect(result.code).not.toBe(0);
    await expect(access(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(fixture.root, ".git/objects", oid.slice(0, 2), oid.slice(2)))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it.each(["extensions.partialclone\norigin\0", "remote.origin.promisor\ntrue\0", "remote.origin.partialclonefilter\nblob:none\0", "filter.test.process\ncommand\0"])("rejects unsafe effective configuration %s", async (configuration) => {
    await expect(requireSafeGitConfiguration(async () => ({ code: 0, stdout: Buffer.from(configuration), stderr: "" }))).rejects.toMatchObject({ statusCode: 415 });
  });
  it("accepts explicitly disabled promisor and empty clean config", async () => {
    await expect(requireSafeGitConfiguration(async () => ({ code: 0, stdout: Buffer.from("remote.origin.promisor\nfalse\0filter.test.clean\n\0"), stderr: "" }))).resolves.toBeUndefined();
  });
});
