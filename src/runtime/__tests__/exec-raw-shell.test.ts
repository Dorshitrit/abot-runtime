import { access, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createExecCommandPathFixture } from "./support/exec-command-path-fixture.js";
import { disposeCompositionFixtures } from "./support/runtime-composition-fixture.js";

afterEach(disposeCompositionFixtures);

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

test("passes external paths and shell script data directly to the shell", async () => {
  const { plugin, config } = await createExecCommandPathFixture();
  const target = join(config.paths.rootDir, "external.txt");
  await writeFile(target, "obsolete\nfixture-content\n");
  const result = await plugin.handlers.exec!({
    cwd: ".",
    command: `sed -i.bak '/obsolete/d' ${quote(target)} && awk '/fixture/ {print $0}' ${quote(target)} && printf '/literal/argument'`,
  });
  expect(result).toMatchObject({
    ok: true,
    stdout: "fixture-content\n/literal/argument",
  });
  expect(await readFile(target, "utf8")).toBe("fixture-content\n");
  expect(await readFile(`${target}.bak`, "utf8")).toBe(
    "obsolete\nfixture-content\n",
  );
});

test("does not infer interactivity or authority from a command name", async () => {
  const { plugin } = await createExecCommandPathFixture();
  const result = await plugin.handlers.exec!({
    cwd: ".",
    command: "ssh -V; printf shell-reached",
  });
  expect(result).toMatchObject({ ok: true, stdout: "shell-reached" });
});

test("preserves exact command characters and whitespace", async () => {
  const { plugin, config } = await createExecCommandPathFixture();
  const literal = "\u0001\uFFFD\r\n";
  const command = `  printf '%s' '${literal}' > exact.txt  `;
  const result = await plugin.handlers.exec!({ cwd: ".", command });
  expect(result).toMatchObject({ ok: true, data: { mutationEvidence: true } });
  expect(
    await readFile(join(config.paths.agentWorkDir, "exact.txt"), "utf8"),
  ).toBe(literal);
});

test.each(["\u0000", " \t\n "])(
  "rejects unrepresentable or empty commands before effects: %j",
  async (invalid) => {
    const { plugin, config } = await createExecCommandPathFixture();
    const command = invalid.includes("\u0000")
      ? `printf changed > marker.txt${invalid}`
      : invalid;
    const result = await plugin.handlers.exec!({ cwd: ".", command });
    expect(result).toMatchObject({
      ok: false,
      errorCode: "exec_command_invalid",
    });
    await expect(
      access(join(config.paths.agentWorkDir, "marker.txt")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  },
);

test("uses an absolute external cwd and observes its changes", async () => {
  const { plugin, config } = await createExecCommandPathFixture();
  const cwd = join(config.paths.rootDir, "external");
  await mkdir(cwd);
  const result = await plugin.handlers.exec!({
    cwd,
    command: "printf outside > marker.txt",
  });
  expect(result).toMatchObject({ ok: true, data: { mutationEvidence: true } });
  expect(result.output).toContain(`CWD: ${cwd}`);
  expect(await readFile(join(cwd, "marker.txt"), "utf8")).toBe("outside");
});

test.each([
  "..",
  "escape",
  "escape/..",
  "workspace/../external",
  "workspace/escape",
  "workspace/escape/..",
])("resolves native cwd outside its contextual base: %s", async (cwd) => {
  const { plugin, config } = await createExecCommandPathFixture();
  const external = join(config.paths.rootDir, "external");
  await mkdir(external);
  await mkdir(config.paths.workspaceDir, { recursive: true });
  await symlink(external, join(config.paths.agentWorkDir, "escape"), "dir");
  await symlink(external, join(config.paths.workspaceDir, "escape"), "dir");
  const expected = cwd.endsWith("..") ? config.paths.rootDir : external;
  const result = await plugin.handlers.exec!({ cwd, command: "pwd -P" });
  expect(result).toMatchObject({ ok: true, stdout: `${expected}\n` });
  expect(result.output).toContain(`CWD: ${expected}`);
});

test("preserves whitespace in physical cwd names and keeps in-base logical aliases", async () => {
  const { plugin, config } = await createExecCommandPathFixture();
  const name = " spaced directory ";
  await mkdir(join(config.paths.agentWorkDir, name));
  await mkdir(join(config.paths.workspaceDir, name), { recursive: true });
  for (const cwd of [name, `workspace/${name}`]) {
    const result = await plugin.handlers.exec!({
      cwd,
      command: "printf exact > marker.txt",
    });
    expect(result).toMatchObject({
      ok: true,
      data: { mutationEvidence: true },
    });
    expect(result.output).toContain(`CWD: ${cwd}\n`);
  }
  expect(
    await readFile(join(config.paths.agentWorkDir, name, "marker.txt"), "utf8"),
  ).toBe("exact");
  expect(
    await readFile(join(config.paths.workspaceDir, name, "marker.txt"), "utf8"),
  ).toBe("exact");
});

test.each([
  ["missing", "exec_cwd_not_found"],
  ["file.txt", "exec_cwd_not_directory"],
  ["invalid\u0000cwd", "exec_cwd_invalid"],
])("requires an existing OS directory: %s", async (cwd, errorCode) => {
  const { plugin, config } = await createExecCommandPathFixture();
  await writeFile(join(config.paths.agentWorkDir, "file.txt"), "fixture");
  const result = await plugin.handlers.exec!({
    cwd,
    command: "printf changed > marker.txt",
  });
  expect(result).toMatchObject({ ok: false, errorCode });
  await expect(
    access(join(config.paths.agentWorkDir, "marker.txt")),
  ).rejects.toMatchObject({ code: "ENOENT" });
});
