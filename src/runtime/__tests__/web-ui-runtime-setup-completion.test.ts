import { describe, expect, test, vi } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { RuntimeSetupService } from "../../web-ui/local-runtime/runtime-setup-service.js";
import { LocalRuntimeApiRouter } from "../../web-ui/local-runtime/api-router.js";
import {
  applyAndCompleteRuntimeSetup,
  pendingRuntimeSetupCatalog,
} from "../../web-ui/local-runtime/runtime-setup-completion.js";

describe("finishing an editable setup", () => {
  test("only finalizes the saved revision after activation succeeds", async () => {
    const setup = {
      status: vi.fn(async () => ({
        editableConnection: { revision: "saved-1" },
      })),
      finalize: vi.fn(async () => true),
    };
    const apply = vi.fn(async () => ({ status: "ready" as const }));
    expect(await applyAndCompleteRuntimeSetup(setup as never, apply)).toEqual({
      status: "ready",
    });
    expect(setup.finalize).toHaveBeenCalledExactlyOnceWith("saved-1");
    expect(apply.mock.invocationCallOrder[0]).toBeLessThan(
      setup.finalize.mock.invocationCallOrder[0],
    );
  });

  test("preserves a draft if the agent is busy or applying fails", async () => {
    const setup = {
      status: async () => ({ editableConnection: { revision: "saved-1" } }),
      finalize: vi.fn(),
    };
    expect(
      await applyAndCompleteRuntimeSetup(setup as never, async () => ({
        status: "restart_required",
      })),
    ).toEqual({ status: "restart_required" });
    await expect(
      applyAndCompleteRuntimeSetup(setup as never, async () => {
        throw new Error("activation failed");
      }),
    ).rejects.toThrow("activation failed");
    expect(setup.finalize).not.toHaveBeenCalled();
  });

  test("does not report completion or close a newer connection saved during apply", async () => {
    const setup = {
      status: async () => ({ editableConnection: { revision: "saved-1" } }),
      finalize: vi.fn(async () => false),
    };
    expect(
      await applyAndCompleteRuntimeSetup(setup as never, async () => ({
        status: "ready",
      })),
    ).toMatchObject({ status: "restart_required" });
    expect(setup.finalize).toHaveBeenCalledWith("saved-1");
  });

  test("keeps established configuration on its existing apply path", async () => {
    const setup = {
      status: async () => ({ status: "ready" }),
      finalize: vi.fn(),
    };
    expect(
      await applyAndCompleteRuntimeSetup(setup as never, async () => ({
        status: "ready",
      })),
    ).toEqual({ status: "ready" });
    expect(setup.finalize).not.toHaveBeenCalled();
    expect(await pendingRuntimeSetupCatalog(setup as never)).toBeNull();
  });

  test("keeps an unfinished wizard visible when the page reloads its model catalog", async () => {
    const setup = {
      status: async () => ({ editableConnection: { revision: "saved-1" } }),
    };
    expect(await pendingRuntimeSetupCatalog(setup as never)).toMatchObject({
      profiles: [],
      availability: { status: "setup_required" },
    });
  });

  test("routes a resumed draft to onboarding until final apply closes its persisted receipt", async () => {
    const artifacts = resolve(".codex/artifacts/onboarding-back-edit-20260908");
    await mkdir(artifacts, { recursive: true });
    const rootDir = await mkdtemp(join(artifacts, "completion-http-"));
    const configPath = join(rootDir, "local/runtime.config.json");
    try {
      const setup = new RuntimeSetupService({
        rootDir,
        getConfigPath: () => configPath,
        activate: async () => ({ status: "ready" }),
      });
      await setup.save({
        provider: "ollama",
        model: "fixture-chat",
        deferActivation: true,
      });
      const catalog = {
        profiles: [{ id: "default" }],
        availability: { status: "ready" },
      };
      const environments = {
        applyConfiguration: vi.fn(async () => ({ status: "ready" })),
        modelCatalog: vi.fn(() => catalog),
      };
      const router = new LocalRuntimeApiRouter(
        {
          rootDir,
          configPath,
          defaultEnvironmentId: "prod",
          providerAdapters: {} as never,
        },
        environments as never,
        { healthDetails: () => [] } as never,
      );
      async function request(path: string, method = "GET") {
        let response = "";
        await router.handle(
          {
            url: `/web-api/${path}`,
            method,
            headers: { "content-type": "application/json" },
            socket: {},
          } as never,
          {
            writeHead: vi.fn(),
            setHeader: vi.fn(),
            end: (body: string) => {
              response = body;
            },
          } as never,
        );
        return JSON.parse(response);
      }
      expect(await request("chat/models")).toMatchObject({
        profiles: [],
        availability: { status: "setup_required" },
      });
      expect(environments.modelCatalog).not.toHaveBeenCalled();
      expect(await request("runtime/config/apply", "POST")).toMatchObject({
        activation: { status: "ready" },
      });
      expect((await setup.status()).editableConnection).toBeUndefined();
      expect(await request("chat/models")).toMatchObject(catalog);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
