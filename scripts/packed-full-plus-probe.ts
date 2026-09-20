/** Installed-package native system actions through the public approval boundary. */
export function createPackedFullPlusProbe(): string {
  return `
{
  const assert = (await import("node:assert/strict")).default;
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const packageRoot = path.dirname(fileURLToPath(import.meta.resolve("@abot-ai/runtime/package.json")));
  const companionProbeHome = path.join(initializedConsumerRoot, "packed-host-help-home");
  await fs.mkdir(companionProbeHome, { recursive: true });
  const hostHelp = execFileSync(process.execPath, [path.join(packageRoot, "dist/src/cli/bin.js"), "host", "--help"], {
    cwd: initializedConsumerRoot,
    env: { ...process.env, HOME: companionProbeHome, USERPROFILE: companionProbeHome },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000,
  });
  assert.ok(hostHelp.includes("abot host connect --url"), "packed companion command must resolve its complete import closure");
  assert.ok(hostHelp.includes("abot host disconnect"), "packed companion must expose removal controls");
  await assert.rejects(fs.stat(path.join(companionProbeHome, ".abot")), { code: "ENOENT" });
  console.log("packed host companion help verified without pairing, login registration, or native application launch");
  const nativePlatform = process.platform;
  assert.ok(["linux", "darwin"].includes(nativePlatform), "system action probe requires a supported native host");
  const target = nativePlatform === "darwin" ? "macos" : "linux";
  const configPath = path.join(initializedConsumerRoot, "local/runtime.config.json");
  const configBefore = await fs.readFile(configPath);
  const initialized = config.loadRuntimeConfig({ rootDir: initializedConsumerRoot, configPath: "local/runtime.config.json", profileId: "prod", env: {} });
  const registry = defaultAdapters.createDefaultToolRegistry(initialized);
  const registrations = registry.listNormalInvocations();
  const artifactDirectory = path.join(initializedConsumerRoot, "packed-full-plus-artifacts");
  await fs.mkdir(artifactDirectory, { recursive: true });
  const relative = path.relative(initialized.paths.agentWorkDir, artifactDirectory);
  assert.ok(relative.startsWith("..") || path.isAbsolute(relative), "probe must target outside agentWorkDir");
  let approvalSequence = 0;
  const execute = (mode, call, toolApprovalController) => {
    const executor = adapters.createRegisteredToolNormalInvocationExecutor({
      registrations, toolRegistry: registry, requestId: "packed-system-actions",
      abortSignal: new AbortController().signal, toolPermissionMode: mode,
      sharedState: { requestContext: { agentMode: "fast", toolPermissionMode: mode } },
      toolApprovalController, nextApprovalId: () => "packed-approval-" + ++approvalSequence,
    });
    const operationId = call.tool === "system_command" ? "run_system_command" : "discover_system_targets";
    const handle = executor.operations.find(({ operation }) => operation.operationId === operationId).handle;
    return executor.execute({ handle, controls: call.params });
  };
  const discovery = await execute("full_plus", { tool: "system_targets", params: {} });
  assert.equal(discovery.status, "executed", JSON.stringify(discovery));
  assert.ok(discovery.result.data.targets.some((entry) => entry.id === target && entry.available === true && entry.transport === "native"));
  for (const mode of ["ask", "full_access", "full_plus"]) {
    const fileName = mode + "-native.txt";
    const artifact = path.join(artifactDirectory, fileName);
    const expected = "packed-system-action-" + mode + "-" + nativePlatform;
    const call = { tool: "system_command", params: { target, cwd: artifactDirectory, command: "printf '%s' '" + expected + "' > " + fileName } };
    let approvalCount = 0;
    if (mode !== "full_plus") {
      const missing = await execute(mode, call);
      assert.equal(missing.code, "tool_approval_unavailable");
      const denied = await execute(mode, call, { requestToolApproval: async () => ({ approved: false }) });
      assert.equal(denied.code, "tool_approval_rejected");
      await assert.rejects(fs.stat(artifact), { code: "ENOENT" });
    }
    const completed = await execute(mode, call, {
      requestToolApproval: async (request) => {
        approvalCount += 1;
        assert.deepEqual(request.call, call, "approval must bind the exact command");
        await assert.rejects(fs.stat(artifact), { code: "ENOENT" });
        return { approved: true };
      },
    });
    assert.equal(approvalCount, mode === "full_plus" ? 0 : 1);
    assert.equal(completed.status, "executed", JSON.stringify(completed));
    assert.equal(completed.result.ok, true, JSON.stringify(completed));
    assert.equal(completed.result.exitCode, 0);
    assert.equal(completed.result.data.target, target);
    assert.deepEqual(await fs.readFile(artifact), Buffer.from(expected, "utf8"));
  }
  assert.deepEqual(await fs.readFile(configPath), configBefore, "system actions must not rewrite workspace config");
  assert.equal(initialized.paths.agentWorkDir, config.loadRuntimeConfig({ rootDir: initializedConsumerRoot, configPath: "local/runtime.config.json", profileId: "prod", env: {} }).paths.agentWorkDir);
  console.log("packed system actions verified: native-" + nativePlatform + ", ASK/FULL approval, FULL+ automatic, exact outside-project bytes, unchanged config");
}
`;
}
