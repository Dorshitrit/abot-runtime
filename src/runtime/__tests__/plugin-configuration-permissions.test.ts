import { readFileSync } from "node:fs";
import { chmod, lstat, readFile } from "node:fs/promises";
import { expect, test, vi } from "vitest";
import {
  pluginConfigurationPath,
  readPluginConfigurationStore,
} from "../plugins/configuration-store.js";
import { loadConfiguredRuntimePlugins } from "../plugins/loader.js";
import {
  configurationRequest,
  pluginConfigurationFixture,
} from "./support/plugin-configuration-fixture.js";

vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, readFileSync: vi.fn(fs.readFileSync) };
});

test
  .skipIf(process.platform === "win32")
  .each([0o640, 0o604, 0o620, 0o602, 0o610, 0o601])(
  "exposed store mode %i rejects reads and writes before reading credentials",
  async (mode) => {
    const f = await pluginConfigurationFixture();
    await f.save(
      {},
      { token: { action: "set", value: "private-permissions-fixture" } },
    );
    const revision = f.view().revision;
    const path = pluginConfigurationPath(f.rootDir);
    const before = await readFile(path, "utf8");
    await chmod(path, mode);
    vi.mocked(readFileSync).mockClear();

    expect(() => readPluginConfigurationStore(f.rootDir)).toThrow("chmod 600");
    expect(() => loadConfiguredRuntimePlugins({ ...f.config })).toThrow(
      "chmod 600",
    );
    const get = await configurationRequest(f.routes, "GET");
    const put = await configurationRequest(f.routes, "PUT", {
      revision,
      settings: {},
    });
    for (const response of [get, put]) {
      expect(response.status).toBe(409);
      expect(response.payload.error).toBe("unsafe_plugin_configuration");
      expect(JSON.stringify(response.payload)).not.toContain(
        "private-permissions-fixture",
      );
    }
    expect(
      vi.mocked(readFileSync).mock.calls.some(([file]) => file === path),
    ).toBe(false);
    expect(await readFile(path, "utf8")).toBe(before);
    expect((await lstat(path)).mode & 0o777).toBe(mode);

    await chmod(path, 0o600);
    expect((await configurationRequest(f.routes, "GET")).status).toBe(200);
    expect(
      (
        await configurationRequest(f.routes, "PUT", {
          revision,
          settings: { query: "repaired" },
        })
      ).status,
    ).toBe(200);
    expect(f.view().settings.query).toBe("repaired");
  },
);

test.skipIf(process.platform === "win32")(
  "owner-only read permission remains readable",
  async () => {
    const f = await pluginConfigurationFixture();
    await f.save({ query: "retained" });
    await chmod(pluginConfigurationPath(f.rootDir), 0o400);
    expect(f.view().settings.query).toBe("retained");
  },
);
