import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test, vi } from "vitest";
import { dispatchLocalLearningCall } from "../local-host/app-learning-dispatch.js";
import { createLocalLearningClient } from "../local-host/client-learning.js";
import { readLearningPreferencesInput } from "../local-host/learning-preferences-input.js";
import { DEFAULT_LEARNING_PREFERENCES, normalizeLearningPreferences } from "../passive-learning/store.js";
import type {
  PassiveLearningService,
  PassiveLearningStatus,
} from "../passive-learning/contracts.js";
import { PassiveLearningRoutes } from "../../web-ui/local-runtime/learning-routes.js";
import { createLearningChangeNotifier } from "../../web-ui/local-runtime/learning-notifications.js";
import { createRuntimeWebClient } from "../../web-ui/app/services/runtime-web-client.js";
import {
  readBody,
  readJsonBody,
  pathSegments,
  sendJson,
} from "../../web-ui/local-runtime/http.js";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
});

async function harness() {
  const status: PassiveLearningStatus = {
    preferences: { enabled: false, excludedApplications: [] },
    state: "off",
    pendingObservations: 0,
    processing: false,
    droppedObservations: 0,
    recentMemories: [],
  };
  const service = {
    configure: vi.fn(async () => status),
    candidates: vi.fn(async () => []),
    dismissProposal: vi.fn(async () => undefined),
    status: vi.fn(async () => status),
  } as unknown as PassiveLearningService;
  const call = vi.fn(async (method: string, args: readonly unknown[]) =>
    dispatchLocalLearningCall(service, method, args),
  );
  const local = createLocalLearningClient(call);
  const resolveService = vi.fn(() => local.service);
  const routes = new PassiveLearningRoutes(resolveService);
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const segments = pathSegments(url.pathname);
    const body =
      request.method === "GET" ? null : readJsonBody(await readBody(request));
    const handled = await routes.handle({
      method: request.method ?? "GET",
      route: segments.join("/"),
      segments,
      url,
      body,
      environmentId:
        url.searchParams.get("environment") ??
        String(body?.environment ?? "dev"),
      request,
      response,
    });
    if (!handled) sendJson(response, 404, { ok: false });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const browser = createRuntimeWebClient({
    getConfig: () => ({ apiBasePath: origin }),
    getEnvironmentId: () => "dev",
    origin,
  });
  return { origin, browser, service, call, resolveService };
}

describe("Co-worker management boundaries", () => {
  test("carries the exclusive count trigger across HTTP and RPC and rejects impossible thresholds", async () => {
    const { browser, service } = await harness();
    await browser.configurePassiveLearning({ analysisTrigger: "observations", analysisObservationCount: 100 });
    expect(service.configure).toHaveBeenCalledExactlyOnceWith({ analysisTrigger: "observations", analysisObservationCount: 100 });
    for (const input of [{ analysisTrigger: "either" }, { analysisObservationCount: 0 },
      { analysisObservationCount: 257 }, { analysisObservationCount: 1.5 }, { analysisObservationCount: null }]) {
      expect(() => readLearningPreferencesInput(input)).toThrow();
    }
  });

  test("clears an explicit proactive model through HTTP and RPC while omission preserves it", async () => {
    const { browser, service } = await harness();
    let preferences = normalizeLearningPreferences({ modelProfileId: "learning", proactiveModelProfileId: "cloud" }, DEFAULT_LEARNING_PREFERENCES);
    vi.mocked(service.configure).mockImplementation(async (input) => {
      preferences = normalizeLearningPreferences(input, preferences);
      return { ...await service.status(), preferences };
    });
    await browser.configurePassiveLearning({ analysisIntervalMinutes: 20 });
    expect(preferences.proactiveModelProfileId).toBe("cloud");
    await expect(browser.configurePassiveLearning({ proactiveModelProfileId: null })).resolves.toMatchObject({ ok: true });
    expect(service.configure).toHaveBeenLastCalledWith({ proactiveModelProfileId: null });
    expect(preferences.proactiveModelProfileId).toBeUndefined();
    expect(preferences.modelProfileId).toBe("learning");
    await browser.configurePassiveLearning({ modelProfileId: "replacement" });
    expect(preferences.proactiveModelProfileId ?? preferences.modelProfileId).toBe("replacement");
    await browser.configurePassiveLearning({ proactiveModelProfileId: "cloud-2" });
    expect(preferences.proactiveModelProfileId).toBe("cloud-2");
  });

  test("browser candidate reads and dismissal retain exact environment and proposal identity across RPC", async () => {
    const { browser, service, call, resolveService } = await harness();
    expect(await browser.listPassiveLearningCandidates("prod")).toEqual({
      ok: true,
      items: [],
    });
    expect(call).toHaveBeenLastCalledWith("learning.candidates", []);
    expect(resolveService).toHaveBeenLastCalledWith("prod");
    expect(
      await browser.dismissPassiveLearningProposal("proposal-1", "prod"),
    ).toEqual({ ok: true });
    expect(call).toHaveBeenLastCalledWith("learning.dismissProposal", [
      "proposal-1",
    ]);
    expect(service.dismissProposal).toHaveBeenCalledExactlyOnceWith(
      "proposal-1",
    );
    expect(service.configure).not.toHaveBeenCalled();
  });

  test.each([
    [{ "content-type": "application/json", origin: "https://other.test" }, 403],
    [
      { "content-type": "application/json", "sec-fetch-site": "cross-site" },
      403,
    ],
    [{ "content-type": "text/plain" }, 415],
  ] as const)(
    "dismissal rejects unauthorized metadata before resolving the environment",
    async (headers, expected) => {
      const { origin, service, resolveService } = await harness();
      const response = await fetch(
        `${origin}/runtime/learning/proposals/id?environment=prod`,
        { method: "DELETE", headers, body: "{}" },
      );
      expect(response.status).toBe(expected);
      expect(resolveService).not.toHaveBeenCalled();
      expect(service.dismissProposal).not.toHaveBeenCalled();
    },
  );

  test("all new preferences cross the same canonical validator without expanding the partial update", async () => {
    const { browser, service, resolveService } = await harness();
    const input = {
      collectionWindow: {
        start: "08:00",
        end: "18:00",
        timeZone: "Asia/Jerusalem",
      },
      proactiveEnabled: true,
      proactiveModelProfileId: "cloud",
      proactiveIntervalMinutes: 60,
      proactiveWindow: null,
      proactiveMessagesPerDay: 2,
      maturation: {
        promotionScore: 90,
        retentionDays: 30,
        maxCandidates: 500,
        maxBytes: 2097152,
      },
      resourceLimits: {
        modelCallsPerDay: 24,
        embeddingCallsPerDay: 96,
        embeddingCharactersPerDay: 1048576,
        maxConcurrentCalls: 1,
        timeZone: "UTC",
      },
    };
    await browser.configurePassiveLearning(input, "prod");
    expect(service.configure).toHaveBeenCalledExactlyOnceWith(input);
    expect(resolveService).toHaveBeenCalledWith("prod");
    expect(
      readLearningPreferencesInput({
        proactiveEnabled: false,
        enabled: undefined,
      }),
    ).toEqual({ proactiveEnabled: false });
  });

  test.each([
    { proactiveEnabled: "true" },
    { proactiveIntervalMinutes: 0 },
    { proactiveWindow: { start: "08:00", end: "17:00", timeZone: "invalid" } },
    {
      maturation: {
        promotionScore: 101,
        retentionDays: 30,
        maxCandidates: 500,
        maxBytes: 2097152,
      },
    },
    {
      resourceLimits: {
        modelCallsPerDay: 24,
        embeddingCallsPerDay: 96,
        embeddingCharactersPerDay: 100,
        maxConcurrentCalls: 1,
      },
    },
    { resourceLimits: null },
    { modelProfileId: null },
    { proactiveEnabled: null },
    { observations: [] },
    { proactivePrompt: "override" },
  ])(
    "rejects invalid or unauthorized preferences at HTTP and direct RPC",
    async (input) => {
      const { origin, service } = await harness();
      const response = await fetch(`${origin}/runtime/learning`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      expect(response.status).toBe(400);
      expect(() =>
        dispatchLocalLearningCall(service, "learning.configure", [input]),
      ).toThrow();
      expect(service.configure).not.toHaveBeenCalled();
    },
  );

  test("management RPC cannot publish events or mutate candidate contents", () => {
    const service = {} as PassiveLearningService;
    for (const method of [
      "learning.notifyKnowledgeChanged",
      "learning.subscribe",
      "learning.promote",
      "learning.propose",
    ])
      expect(() => dispatchLocalLearningCall(service, method, [])).toThrow(
        "local_runtime_method_unknown",
      );
    expect(() =>
      dispatchLocalLearningCall(service, "learning.dismissProposal", ["", {}]),
    ).toThrow("passive_learning_proposal_invalid");
    expect(() =>
      dispatchLocalLearningCall(service, "learning.candidates", [
        { content: "injected" },
      ]),
    ).toThrow("passive_learning_candidates_invalid");
  });

  test("delivery identity reaches learning and workspace projections; event content is never forwarded", () => {
    const broadcast = vi.fn();
    const publish = createLearningChangeNotifier({ broadcast });
    const learning = createLocalLearningClient(vi.fn());
    learning.subscribe((event) => publish("prod", event));
    const event = {
      type: "proposal_delivered",
      proposalId: "proposal",
      sessionId: "session",
    };
    learning.receive({
      type: "learning.changed",
      event: { ...event, content: "private", observations: ["private"] },
    });
    expect(broadcast.mock.calls).toEqual([
      [{ type: "learning.changed", environmentId: "prod", event }],
      [
        {
          type: "workspace_changed",
          environment: "prod",
          resources: ["sessions"],
        },
      ],
    ]);
    broadcast.mockClear();
    learning.receive({
      type: "learning.changed",
      event: { ...event, sessionId: "" },
    });
    expect(broadcast).toHaveBeenCalledExactlyOnceWith({
      type: "learning.changed",
      environmentId: "prod",
    });
  });
});
