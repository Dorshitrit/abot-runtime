import { describe, expect, test } from "vitest";
import { secretProtectionCases } from "./support/secret-protection-cases.js";
import {
  sensitiveText, systemProtectionOwners, testSystemApplication,
  testSystemCatalog, testSystemProcess, testSystemTargets,
} from "./support/system-result-protection-fixture.js";

describe.each(systemProtectionOwners)("$owner typed result protection", ({ protection }) => {
  test.each(secretProtectionCases)("$name protects only typed fields and preserves safe identities", ({ input, expected }) => {
    const process = testSystemProcess(input);
    const before = structuredClone(process);
    expect(protection.protectProcess(process)).toEqual({
      ...process, stdout: expected, stderr: expected,
      spawnedProcess: { ...process.spawnedProcess, executable: expected },
    });
    expect(process).toEqual(before);
    expect(protection.protectMessage(input)).toBe(expected);

    const targets = testSystemTargets(input);
    const protectedTargets = protection.protectTargets(targets);
    expect(protectedTargets.host).toEqual({ ...targets.host, kernelRelease: expected });
    expect(protectedTargets.targets[1]).toEqual({ id: "macos", available: false, reason: expected });
    const changed = input !== expected;
    if (changed) {
      expect(protectedTargets.targets[0]).toMatchObject({ id: "windows", available: false });
      expect(protectedTargets.targets[0]).not.toHaveProperty("shell");
    } else {
      expect(protectedTargets.targets[0]).toEqual(targets.targets[0]);
    }
    const identity = testSystemApplication(input);
    const named = testSystemApplication("Safe.App", input);
    const catalog = testSystemCatalog([identity, named], input);
    expect(protection.protectApplication(identity)).toEqual(changed ? undefined : identity);
    expect(protection.protectApplication(named)).toEqual({ ...named, name: expected });
    expect(protection.protectCatalog(catalog)).toEqual({
      ...catalog, complete: !changed,
      scope: { ...catalog.scope, roots: [expected] },
      applications: [...(changed ? [] : [identity]), { ...named, name: expected }],
    });
    expect(catalog.applications).toEqual([identity, named]);
  });

  test.each(["completed", "timeout", "aborted", "spawn_failed", "output_failed"] as const)(
    "%s incomplete capture cannot imply a complete secret scan", (status) => {
      const process = { ...testSystemProcess(sensitiveText), status, exitCode: null, outputTruncated: true };
      const protectedProcess = protection.protectProcess(process);
      expect(protectedProcess).toMatchObject({
        status, exitCode: null, outputTruncated: true,
        stdout: "[UNAVAILABLE: incomplete output cannot be scanned for secrets]",
        stderr: "[UNAVAILABLE: incomplete output cannot be scanned for secrets]",
        spawnedProcess: { pid: 123, executable: "[REDACTED]", pidNamespace: "runtime_os", identitySource: "spawn_arguments" },
      });
      expect(JSON.stringify(protectedProcess)).not.toContain("synthetic-private");
    },
  );

  test("complete large ordinary output remains exact and has no new size cap", () => {
    const text = "ordinary שלום 🚀\n".repeat(50_000);
    const process = { ...testSystemProcess(text), spawnedProcess: undefined };
    expect(Buffer.byteLength(text)).toBeGreaterThan(1_000_000);
    expect(protection.protectProcess(process)).toEqual(process);
  });

  test("an already incomplete catalog stays incomplete", () => {
    const catalog = { ...testSystemCatalog([testSystemApplication()]), complete: false };
    expect(protection.protectCatalog(catalog)).toEqual(catalog);
  });
});
