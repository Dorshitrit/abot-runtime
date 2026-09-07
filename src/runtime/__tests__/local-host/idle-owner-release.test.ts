import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { createSchedulerRuntimeFixture } from "../support/scheduler-runtime-fixture.js";

test("an already-idle canonical owner releases its lease before close resolves and process exits", async () => {
  const fixture = await createSchedulerRuntimeFixture();
  try {
    await fixture.application.stop();
    const configPath = join(fixture.rootDir, "owner-exit-config.json");
    await writeFile(configPath, JSON.stringify(fixture.config));
    const child = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        fileURLToPath(new URL("./idle-owner-exit-worker.ts", import.meta.url)),
        configPath,
      ],
      { encoding: "utf8", timeout: 15_000 },
    );
    expect(child.status, child.stderr).toBe(0);
    const directory = join(fixture.config.paths.runtimeDir, "local-host");
    const ownerPath = join(directory, "owner");
    const leasePath = join(ownerPath, "lease");
    const diagnostic = JSON.stringify({
      leaseEntries: existsSync(leasePath) ? readdirSync(leasePath) : null,
    });
    expect(existsSync(ownerPath), diagnostic).toBe(false);
    expect(existsSync(join(directory, "endpoint.json"))).toBe(false);
    expect(fixture.invoke).not.toHaveBeenCalled();
  } finally {
    await fixture.dispose();
  }
});
