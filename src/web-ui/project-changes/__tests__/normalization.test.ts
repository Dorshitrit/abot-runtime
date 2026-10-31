import { expect, it, describe } from "vitest";
import { projectChangesFixture } from "./fixture.js";
import { chmod } from "node:fs/promises";
import { join } from "node:path";

async function changed(autocrlf: string, attributes?: string, initial = "one\ntwo\n") {
  const fixture = await projectChangesFixture();
  await fixture.git("config", "core.autocrlf", "false");
  if (attributes) await fixture.write(".gitattributes", attributes);
  await fixture.write("file.txt", initial); await fixture.commit();
  await fixture.git("config", "core.autocrlf", autocrlf);
  return fixture;
}
async function list(fixture: Awaited<ReturnType<typeof changed>>) {
  const result = await fixture.service.list("dev", "session-1");
  expect(result.status, result.message).toBe("available"); return result;
}
describe("Git standard text normalization", () => {
  it.each(["true", "input"])("keeps touched autocrlf=%s CRLF clean and shows only actual changed lines", async (autocrlf) => {
    const fixture = await changed(autocrlf);
    await fixture.write("file.txt", "one\r\ntwo\r\n");
    expect((await list(fixture)).files).toEqual([]);
    await fixture.write("file.txt", "one\r\nchanged\r\n");
    const result = await list(fixture);
    expect(result.files[0]).toMatchObject({ path: "file.txt", additions: 1, deletions: 1 });
    const preview = await fixture.service.file("dev", "session-1", result.files[0]!.id, result.revision!);
    expect(preview.patch).toContain("-two\n+changed\n"); expect(preview.patch).not.toContain("\r");
    await fixture.write("file.txt", "one\r\ntwo");
    const noNewline = await list(fixture);
    expect(noNewline.files[0]).toMatchObject({ additions: 1, deletions: 1 });
  });
  it("normalizes oversized preview text inside the identity budget before deciding it changed", async () => {
    const baseline = "line\n".repeat(60000);
    const fixture = await changed("true", undefined, baseline);
    await fixture.write("file.txt", baseline.replace(/\n/gu, "\r\n"));
    expect((await list(fixture)).files).toEqual([]);
    await fixture.write("file.txt", `${baseline.replace(/\n/gu, "\r\n")}changed\r\n`);
    const result = await list(fixture);
    expect(result.files[0]).toMatchObject({ path: "file.txt", additions: null, deletions: null });
    expect((await fixture.service.file("dev", "session-1", result.files[0]!.id, result.revision!)).status).toBe("too_large");
  });
  it.each(["text eol=crlf", "text eol=lf", "eol=crlf", "eol=lf", "crlf=input"])("honors %s without global autocrlf", async (attribute) => {
    const fixture = await changed("false", `*.txt ${attribute}\n`);
    await fixture.write("file.txt", "one\r\ntwo\r\n");
    expect((await list(fixture)).files).toEqual([]);
  });
  it("preserves genuine CRLF with -text and preserves lone CR in auto mode", async () => {
    const fixture = await changed("true", "*.txt -text eol=crlf\n");
    await fixture.write("file.txt", "one\r\ntwo\r\n");
    expect((await list(fixture)).files[0]).toMatchObject({ additions: 2, deletions: 2 });
    const auto = await changed("true"); await auto.write("file.txt", "one\rtwo\r\n");
    const result = await list(auto);
    const preview = await auto.service.file("dev", "session-1", result.files[0]!.id, result.revision!);
    expect(preview.patch).toContain("+one\rtwo\r\n");
  });
  it("uses stage0 index CRLF protection for text=auto, while explicit text normalizes", async () => {
    const fixture = await changed("false", undefined, "one\r\ntwo\r\n");
    await fixture.write(".gitattributes", "*.txt text=auto eol=lf\n");
    await fixture.write("file.txt", "one\r\nchanged\r\n");
    let result = await list(fixture);
    expect(result.files.find((file) => file.path === "file.txt")).toMatchObject({ additions: 1, deletions: 1 });
    await fixture.write(".gitattributes", "*.txt text\n");
    result = await list(fixture);
    expect(result.files.find((file) => file.path === "file.txt")).toMatchObject({ additions: 2, deletions: 2 });
  });
  it("retains staged mode changes when core.filemode=false", async () => {
    const fixture = await changed("false"); await fixture.git("config", "core.filemode", "false");
    await fixture.git("update-index", "--chmod=+x", "--", "file.txt");
    await chmod(join(fixture.root, "file.txt"), 0o644);
    const result = await list(fixture);
    expect(result.files[0]).toMatchObject({ path: "file.txt", additions: 0, deletions: 0 });
    const preview = await fixture.service.file("dev", "session-1", result.files[0]!.id, result.revision!);
    expect(preview.patch).toContain("old mode 100644\nnew mode 100755");
  });
  it("makes unsupported transforms explicit and invalidates changed attributes/config", async () => {
    const fixture = await changed("false"); await fixture.write("file.txt", "changed\n");
    const initial = await list(fixture);
    await fixture.write(".gitattributes", "*.txt ident\n");
    await expect(fixture.service.file("dev", "session-1", initial.files[0]!.id, initial.revision!)).rejects.toMatchObject({ code: "project_changes_stale" });
    const result = await list(fixture);
    const file = result.files.find((entry) => entry.path === "file.txt")!;
    expect((await fixture.service.file("dev", "session-1", file.id, result.revision!)).status).toBe("unavailable");
    await fixture.git("config", "core.autocrlf", "true");
    await expect(fixture.service.file("dev", "session-1", file.id, result.revision!)).rejects.toMatchObject({ code: "project_changes_stale" });
  });
});
