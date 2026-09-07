/** Executes installed plugin capabilities against directories created by the real packed CLI. */
export function createPackedSystemToolsProbe(): string {
  return `
{
  const assert = (await import("node:assert/strict")).default;
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
  const nativePlatform = process.platform;
  assert.ok(["linux", "darwin"].includes(nativePlatform), "packed system tools require Linux or macOS");
  assert.ok(platformDescriptor, "process platform descriptor must be restorable");

  // The CLI consumer was initialized through the installed package bin. Never
  // create its work roots here: doing so would hide a broken fresh installation.
  for (const profileId of ["prod", "dev"]) {
    const initialized = config.loadRuntimeConfig({
      rootDir: initializedConsumerRoot,
      configPath: "local/runtime.config.json",
      profileId,
      env: {},
    });
    assert.equal(
      (await fs.stat(initialized.paths.agentWorkDir)).isDirectory(),
      true,
      "packed init omitted the configured " + profileId + " work root",
    );
  }
  const initializedConfig = config.loadRuntimeConfig({
    rootDir: initializedConsumerRoot,
    configPath: "local/runtime.config.json",
    profileId: "prod",
    env: {},
  });
  const modes = [{ platform: nativePlatform, label: "native-" + nativePlatform }];
  if (nativePlatform === "linux") {
    modes.push({ platform: "darwin", label: "simulated-darwin-on-linux" });
  }

  async function requireToolSuccess(registry, tool, params, label) {
    const result = await registry.execute({ tool, params });
    assert.equal(result.ok, true, "packed " + label + " " + tool + " failed: " + JSON.stringify(result));
    return result;
  }

  async function requireArtifactBytes(logicalPath, expected, label) {
    const actual = await fs.readFile(path.join(initializedConfig.paths.agentWorkDir, logicalPath));
    assert.deepEqual(actual, Buffer.from(expected, "utf8"), "packed " + label + " artifact bytes: " + logicalPath);
  }

  try {
    for (const mode of modes) {
      // This exercises the serialized macOS helper inside bundled plugins on
      // Linux. It is deliberately labelled simulation, not native Mac validation.
      Object.defineProperty(process, "platform", { ...platformDescriptor, value: mode.platform });
      const registry = defaultAdapters.createDefaultToolRegistry(initializedConfig);
      const filename = "packed-system-" + mode.label + ".txt";
      const initial = "alpha\\npacked-original-" + mode.label + " שלום\\nomega\\n";
      await requireToolSuccess(registry, "write_file", { path: filename, content: initial }, mode.label);
      await requireArtifactBytes(filename, initial, mode.label);

      const read = await requireToolSuccess(registry, "read_file", { path: filename }, mode.label);
      assert.ok(read.output.includes(initial), "packed read_file omitted expected UTF-8 content");

      const editedLine = "packed-edited-" + mode.label + " שלום";
      await requireToolSuccess(registry, "edit_file", {
        path: filename,
        instruction: "Replace only the second line with the supplied text.",
        selection: JSON.stringify({ placement: "replace", start_line: 2, end_line: 2 }),
        content: editedLine,
      }, mode.label);
      const edited = "alpha\\n" + editedLine + "\\nomega\\n";
      await requireArtifactBytes(filename, edited, mode.label);

      const nestedPath = "packed-" + mode.label + "/nested/created.txt";
      await requireToolSuccess(registry, "write_file", { path: nestedPath, content: edited }, mode.label);
      await requireArtifactBytes(nestedPath, edited, mode.label);

      const directoryView = await requireToolSuccess(registry, "dev_view", { path: "." }, mode.label);
      assert.ok(directoryView.output.includes(filename), "packed directory inspection omitted the created file");
      const fileView = await requireToolSuccess(registry, "dev_view", {
        path: filename, start_line: 2, end_line: 2,
      }, mode.label);
      assert.ok(fileView.output.includes(editedLine), "packed file inspection omitted the edited line");

      const names = await requireToolSuccess(registry, "local_search", {
        query: filename, path: ".", mode: "names",
      }, mode.label);
      assert.ok(names.output.includes(filename), "packed filename search omitted the created file");
      const directoryMatches = await requireToolSuccess(registry, "local_search", {
        query: editedLine, path: ".", mode: "content",
      }, mode.label);
      assert.ok(directoryMatches.output.includes(filename), "packed directory search omitted the edited file");
      const fileMatches = await requireToolSuccess(registry, "local_search", {
        query: editedLine, path: filename, mode: "content",
      }, mode.label);
      assert.ok(fileMatches.output.includes(editedLine), "packed stdin search omitted the edited text");

      const execPath = "packed-exec-" + mode.label + ".txt";
      const execContent = "packed-exec-" + mode.label;
      await requireToolSuccess(registry, "exec", {
        command: "printf '%s' '" + execContent + "' > '" + execPath + "'",
        cwd: ".",
      }, mode.label);
      await requireArtifactBytes(execPath, execContent, mode.label);
    }
  } finally {
    Object.defineProperty(process, "platform", platformDescriptor);
  }
  console.log("packed system tools verified: " + modes.map(({ label }) => label).join(", "));
}
`;
}
