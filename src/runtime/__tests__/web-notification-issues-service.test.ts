import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type WebSocket from "ws";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { RuntimeConfig } from "../ports.js";
import type { WebNotification } from "../../web-ui/notifications/contracts.js";
import { WebNotificationService } from "../../web-ui/notifications/service.js";
import { notificationStorePath } from "../../web-ui/notifications/store.js";
import { RealtimeClientHub } from "../../web-ui/local-runtime/realtime-hub.js";
import { NotificationIssueBatch, ISSUE_PENDING_LIMIT } from "../../web-ui/notifications/issue-batch.js";
import { projectNotificationIssue } from "../../web-ui/notifications/issue-source-projection.js";
import { parseNotificationReadBody } from "../../web-ui/notifications/request-input.js";
import { decodeModelIssues, encodeModelIssues, type ModelIssueDiagnostic } from "../../model-gateway/protocol/model-issue.js";
import { modelIssueObserver } from "../model/model-issue-event.js";

const metrics = vi.hoisted(() => ({ writes: 0, bytes: 0, sessionLoads: 0, failWrite: false, failPath: "", sparkSession: false }));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs, writeFile: async (...args: Parameters<typeof fs.writeFile>) => {
    if (metrics.failWrite || (metrics.failPath && String(args[0]).startsWith(metrics.failPath))) throw new Error("synthetic disk write failure");
    const result = await fs.writeFile(...args);
    metrics.writes++;
    metrics.bytes += typeof args[1] === "string" ? Buffer.byteLength(args[1]) : 0;
    return result;
  } };
});
vi.mock("../../sessions/session-store.js", () => ({ loadSessionFile: async (_directory: string, id: string) => {
  metrics.sessionLoads++;
  return metrics.sparkSession && id === "spark-companion" ? { id, kind: "spark" } : null;
} }));

const roots: string[] = [];
const services: WebNotificationService[] = [];
beforeEach(() => { metrics.writes = metrics.bytes = metrics.sessionLoads = 0; metrics.failWrite = false; metrics.failPath = ""; metrics.sparkSession = false; });
afterEach(async () => {
  metrics.failWrite = false;
  metrics.failPath = "";
  await Promise.all(services.splice(0).map((service) => service.stop()));
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  vi.restoreAllMocks();
});
function event(index = 0, overrides: Record<string, unknown> = {}) {
  return { type: "event", name: "model.issue.observed", environment: "dev", sessionId: `session-${index}`, requestId: `request-${index}`,
    invocationId: `invocation-${index}`, issueId: `issue-${index}`, occurredAt: 1000, profileId: "profile", provider: "openai", providerId: "openai-primary",
    model: "reasoning-model", modelStep: "chat", code: "model_reasoning_rejected", outcome: "recovered", parameter: "reasoning_effort", requestedValue: "none", ...overrides };
}
const omittedReasoning = { parameter: "reasoning_effort", reasonCode: "model_reasoning_effort_omitted", requestedValue: "none" };
const omittedTemperature = { parameter: "temperature", reasonCode: "model_parameter_requirement_unsatisfied", requestedValue: "0.2" };
function localOmission(index = 0, parameterOmissions: unknown = [omittedReasoning]) {
  return event(index, { code: "model_parameter_omitted", recovery: "parameter_omitted", outcome: "recovered", operation: "chat", parameterOmissions });
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "notification-service-"));
  roots.push(root);
  const environment = (id: string) => ({ services: { config: { paths: { runtimeDir: join(root, id), sessionsDir: join(root, id, "sessions") } } as RuntimeConfig } });
  const deliver = vi.fn(async (_item: WebNotification) => ({ status: "submitted" as const }));
  const changed = vi.fn();
  const service = new WebNotificationService({ hasEnvironment: (id) => id === "dev" || id === "prod", environment,
    isViewing: () => false, changed, deliver, desktop: async () => ({ available: true }), now: () => 2000 });
  services.push(service);
  const path = notificationStorePath({ ...environment("dev").services.config.paths, environmentId: "dev" });
  return { service, deliver, changed, path };
}

test("39 live diagnostics coalesce with one representative session load and no OS alert; replay sends do not collect", async () => {
  const f = await fixture();
  const hub = new RealtimeClientHub((payload) => f.service.observe(payload));
  const client = Object.assign(new EventEmitter(), { readyState: 1, OPEN: 1, send: vi.fn() }) as unknown as WebSocket;
  hub.add(client);
  for (let i = 0; i < 39; i++) hub.broadcast(event(i));
  hub.send(client, event(100));
  await f.service.flush();
  expect((await f.service.list("dev")).items).toMatchObject([{ sourceUrl: "/chat?environment=dev&session=session-38", issue: { occurrenceCount: 39 } }]);
  expect(f.deliver).not.toHaveBeenCalled();
  expect(metrics.sessionLoads).toBe(1);
  expect(metrics.writes).toBe(2); // initialize empty history once, then one atomic burst commit
  expect(f.changed).toHaveBeenCalledTimes(1);
  const writes = metrics.writes;
  const initialLoads = metrics.sessionLoads;
  for (let i = 0; i < 39; i++) f.service.observe(event(i));
  await f.service.flush();
  expect(metrics.writes).toBe(writes);
  console.info(`Live issue burst: 39 events, ${writes} writes (1 initialization + 1 batch), ${metrics.bytes} total bytes, ${initialLoads} representative session load, 0 desktop deliveries.`);
});

test("group source follows verified SPARK kind and later ordinary sources clear that kind, including read ACK", async () => {
  const f = await fixture();
  metrics.sparkSession = true;
  for (let i = 0; i < 38; i++) f.service.observe(event(i));
  f.service.observe(event(38, { sessionId: "spark-companion", occurredAt: 1001 }));
  await f.service.flush();
  expect(metrics.sessionLoads).toBe(1);
  const spark = (await f.service.list("dev")).items[0];
  expect(spark).toMatchObject({ sessionId: "spark-companion", sessionKind: "spark", sourceUrl: "/home?environment=dev&spark=1", issue: { occurrenceCount: 39 } });
  expect((await f.service.markRead("dev", { ids: [spark.id], read: true, observedIssues: [{ id: spark.id, occurrenceCount: 39 }] })).issueStates[0])
    .toMatchObject({ sessionKind: "spark", sourceUrl: "/home?environment=dev&spark=1" });
  f.service.observe(event(39, { occurredAt: 1500 }));
  await f.service.flush();
  const ordinary = (await f.service.list("dev")).items[0];
  expect(ordinary).toMatchObject({ id: spark.id, sourceUrl: "/chat?environment=dev&session=session-39", issue: { occurrenceCount: 40 } });
  expect(ordinary.sessionKind).toBeUndefined();
  metrics.sparkSession = false;
  f.service.observe(event(40, { sessionId: "spark-companion", requestedValue: "high", occurredAt: 1600 }));
  await f.service.flush();
  const unknown = (await f.service.list("dev")).items.find((item) => item.issue?.occurrenceCount === 1)!;
  expect(unknown.sourceUrl).toBe("/chat?environment=dev&session=spark-companion");
  expect(unknown.sessionKind).toBeUndefined();
});

test("only exact durable source linkage suppresses a generic terminal notification; unrelated failures remain", async () => {
  const f = await fixture();
  f.service.observe(event());
  f.service.observe({ type: "failed", environment: "dev", sessionId: "session-0", requestId: "request-0", details: { sourceIssueId: "issue-0" } });
  f.service.observe({ type: "failed", environment: "dev", sessionId: "session-other", requestId: "request-other", details: { sourceIssueId: "issue-0" } });
  await f.service.flush();
  const page = await f.service.list("dev");
  expect(page.items).toHaveLength(2);
  expect(page.items.filter((item) => item.issue)).toHaveLength(1);
  expect(f.deliver).toHaveBeenCalledTimes(1);
  expect(page.items.find((item) => !item.issue)?.requestId).toBe("request-other");
});

test("failed writes retain the owned occurrence for a later flush and never claim successful collection", async () => {
  const f = await fixture();
  await f.service.list("dev");
  const before = await readFile(f.path, "utf8");
  metrics.failWrite = true;
  f.service.observe(event());
  await expect(f.service.flush()).rejects.toThrow("synthetic disk write failure");
  expect(f.changed).not.toHaveBeenCalled();
  expect(await readFile(f.path, "utf8")).toBe(before);
  metrics.failWrite = false;
  await f.service.flush();
  expect((await f.service.list("dev")).items[0].issue?.occurrenceCount).toBe(1);
  expect(f.changed).toHaveBeenCalledTimes(1);
});

test("timeout projection binds exact remediation and stores only allowlisted fields", async () => {
  const f = await fixture();
  const timedOut = event(0, { name: "model.step.timed_out", timeoutMs: 30_000, configuredTimeoutMs: 30_000, timeoutSource: "profile", providerSecret: "DO_NOT_STORE" });
  f.service.observe(timedOut);
  await f.service.flush();
  const item = (await f.service.list("dev")).items[0];
  expect(item.body).toContain('profile "profile"');
  expect(item.issue?.action).toEqual({ kind: "step-timeout", reference: { environment: "dev", sessionId: "session-0", requestId: "request-0", invocationId: "invocation-0" } });
  expect(await readFile(f.path, "utf8")).not.toContain("DO_NOT_STORE");
  expect(f.deliver).not.toHaveBeenCalled();
  expect(projectNotificationIssue({ ...timedOut, issueId: undefined })).toBeUndefined();
  expect(projectNotificationIssue({ ...timedOut, occurredAt: undefined })).toBeUndefined();
});

test("live pending queue is bounded, reports overflow, retains failures and avoids retry loops", async () => {
  let fail = true;
  const persist = vi.fn(async () => { if (fail) throw new Error("disk full"); });
  const reported = vi.fn();
  const batch = new NotificationIssueBatch(persist, reported);
  for (let i = 0; i < ISSUE_PENDING_LIMIT + 3; i++) batch.enqueue(projectNotificationIssue(event(i))!);
  expect(batch.rejectedCount("dev")).toBe(3);
  expect(reported).toHaveBeenCalledTimes(2); // bounded reporting at counts 1 and 2
  await expect(batch.flush()).rejects.toThrow("disk full");
  expect(persist).toHaveBeenCalledTimes(1);
  batch.enqueue(projectNotificationIssue(event(0))!); // pending duplicate does not consume capacity
  expect(batch.rejectedCount("dev")).toBe(3);
  fail = false;
  await batch.flush();
  expect(persist.mock.calls).toHaveLength(1 + Math.ceil(ISSUE_PENDING_LIMIT / 256));
});

test("a failed environment cannot block another environment's diagnostic, ordinary failure, reads or acknowledgements", async () => {
  const f = await fixture();
  await f.service.list("dev");
  metrics.failPath = f.path;
  vi.spyOn(console, "error").mockImplementation(() => {});
  f.service.observe(event(0));
  f.service.observe({ type: "failed", environment: "dev", sessionId: "session-0", requestId: "request-0", details: { sourceIssueId: "issue-0" } });
  f.service.observe(event(1, { environment: "prod" }));
  f.service.observe({ type: "failed", environment: "prod", sessionId: "ordinary", requestId: "ordinary" });
  await expect(f.service.flush()).rejects.toThrow("synthetic disk write failure");
  const prod = await f.service.list("prod");
  expect(prod.items).toHaveLength(2);
  expect(prod.unreadErrorCount).toBe(1);
  expect(f.deliver).toHaveBeenCalledTimes(1);
  expect(f.deliver.mock.calls[0][0].environmentId).toBe("prod");
  expect(await f.service.markRead("prod", { all: true, read: true, issueReadBoundary: prod.readBoundary })).toMatchObject({ unreadErrorCount: 0 });
  metrics.failPath = "";
  await f.service.flush();
  expect((await f.service.list("dev")).items).toMatchObject([{ issue: { occurrenceCount: 1 } }]);
  expect(f.deliver).toHaveBeenCalledTimes(1);
});

test("a full failed-environment queue leaves capacity for other environments", async () => {
  const persisted: string[] = [];
  const batch = new NotificationIssueBatch(async (environment) => {
    if (environment === "dev") throw new Error("dev unavailable");
    persisted.push(environment);
  }, () => {});
  for (let i = 0; i < ISSUE_PENDING_LIMIT; i++) batch.enqueue(projectNotificationIssue(event(i))!);
  batch.enqueue(projectNotificationIssue(event(0, { environment: "prod" }))!);
  await batch.flush("prod");
  expect(persisted).toEqual(["prod"]);
  expect(batch.rejectedCount("prod")).toBe(0);
  await expect(batch.flush()).rejects.toThrow("dev unavailable");
});

test("read parser admits snapshots only for the corresponding IDs and rejects ambiguous selections", () => {
  expect(parseNotificationReadBody({ environment: "dev", ids: ["a"], read: true, observedIssues: [{ id: "a", occurrenceCount: 2 }] }).change)
    .toEqual({ ids: ["a"], read: true, observedIssues: [{ id: "a", occurrenceCount: 2 }] });
  expect(parseNotificationReadBody({ environment: "dev", all: true, read: true, issueReadBoundary: 12 }).change)
    .toEqual({ all: true, read: true, issueReadBoundary: 12 });
  for (const selection of [
    { ids: ["a"], read: true, observedIssues: [{ id: "b", occurrenceCount: 1 }] },
    { ids: ["a"], read: false, observedIssues: [{ id: "a", occurrenceCount: 1 }] },
    { ids: ["a"], read: true, issueReadBoundary: 1 },
    { all: true, read: true, issueReadBoundary: -1 },
    { all: true, read: true, observedIssues: [] },
  ]) expect(() => parseNotificationReadBody({ environment: "dev", ...selection })).toThrow();
});

test("local omissions use declared parameter facts, aggregate once per call and remain separate from provider rejection", async () => {
  const f = await fixture();
  const first = localOmission(0, [omittedReasoning, omittedTemperature]);
  f.service.observe({ ...first, warningMessage: "PRIVATE_RAW_WARNING", responseBody: "PRIVATE_PROVIDER_BODY" });
  f.service.observe(first);
  f.service.observe(localOmission(1, [omittedTemperature, omittedReasoning]));
  f.service.observe(event(2));
  await f.service.flush();
  const page = await f.service.list("dev");
  expect(page.items).toHaveLength(2);
  const local = page.items.find((item) => item.title === "Model settings were omitted")!;
  expect(local).toMatchObject({ severity: "error", channel: "in-app", issue: { occurrenceCount: 2,
    outcomeCounts: { recovered: 2, failed: 0, interrupted: 0 }, action: { kind: "model-settings", profileId: "profile" } } });
  expect(local.body).toContain("Reasoning effort (none): this reasoning level is not supported");
  expect(local.body).toContain("Temperature (0.2): another required setting is missing or incompatible");
  expect(local.body).toContain("before sending a request");
  expect(local.body).not.toMatch(/provider rejected|request succeeded|request continued/i);
  expect(f.deliver).not.toHaveBeenCalled();
  const stored = await readFile(f.path, "utf8");
  expect(stored).not.toContain("PRIVATE_RAW_WARNING");
  expect(stored).not.toContain("PRIVATE_PROVIDER_BODY");
  await f.service.markRead("dev", { ids: [local.id], read: true, observedIssues: [{ id: local.id, occurrenceCount: 2 }] });
  f.service.observe(first);
  await f.service.flush();
  expect((await f.service.list("dev")).items.find((item) => item.id === local.id)?.readAt).not.toBeNull();
});

test("local adjustment does not suppress or claim the cause of a later unrelated request failure", async () => {
  const f = await fixture();
  f.service.observe(localOmission());
  f.service.observe({ type: "failed", environment: "dev", sessionId: "session-0", requestId: "request-0", error: "unrelated_transport_failure" });
  await f.service.flush();
  const page = await f.service.list("dev");
  expect(page.items).toHaveLength(2);
  expect(page.items.find((item) => item.issue)).toMatchObject({ issue: { occurrenceCount: 1,
    outcomeCounts: { recovered: 1, failed: 0, interrupted: 0 } } });
  expect(page.items.find((item) => !item.issue)).toMatchObject({ kind: "failure", title: "Request could not finish" });
  expect(f.deliver).toHaveBeenCalledTimes(1); // Existing ordinary failure policy; the local issue remains in-app.
  expect(f.deliver.mock.calls[0][0].issue).toBeUndefined();
});

test("local grouping separates effective omitted settings and rejects unknown or unsafe parameter facts", async () => {
  const f = await fixture();
  f.service.observe(localOmission(0));
  f.service.observe(localOmission(1, [omittedTemperature]));
  f.service.observe(localOmission(2, [{ ...omittedTemperature, requestedValue: "0.3" }]));
  await f.service.flush();
  expect((await f.service.list("dev")).items.map((item) => item.issue?.occurrenceCount)).toEqual([1, 1, 1]);
  for (const facts of [
    [], [{ ...omittedReasoning, parameter: "unknown_parameter" }],
    [{ ...omittedReasoning, reasonCode: "model_reasoning_effort_mapped" }],
    [{ ...omittedReasoning, requestedValue: "SECRET_RAW_TEXT" }],
    [{ ...omittedTemperature, requestedValue: "NaN" }],
    [omittedReasoning, omittedReasoning],
  ]) expect(projectNotificationIssue(localOmission(3, facts))).toBeUndefined();
  expect(projectNotificationIssue({ ...localOmission(), outcome: "failed" })).toBeUndefined();
  expect(projectNotificationIssue({ ...localOmission(), recovery: "provider_default" })).toBeUndefined();
  const stripped = projectNotificationIssue(localOmission(3, [{ ...omittedReasoning, message: "PRIVATE_WARNING" }]));
  expect(stripped?.body).toContain("Reasoning effort (none)");
  expect(JSON.stringify(stripped)).not.toContain("PRIVATE_WARNING");
  const wrongType = projectNotificationIssue(localOmission(3, [{ ...omittedReasoning, reasonCode: "model_parameter_value_omitted", requestedValue: "0" }]));
  expect(wrongType?.body).toContain("Reasoning effort (0): this value is not valid");
  const unknownSupport = projectNotificationIssue(localOmission(4, [{ parameter: "thinking_budget", reasonCode: "model_thinking_off_unverified", requestedValue: "0" }]));
  expect(unknownSupport?.body).toContain("support for disabling thinking is not declared");
});

test("decoded configured provider names preserve Unicode and spaces through notification grouping", async () => {
  const f = await fixture();
  for (const [providerIndex, providerId] of ["OpenAI Primary", "ספק ראשי"].entries()) {
    for (let occurrence = 0; occurrence < 2; occurrence++) {
      const identity = `${providerIndex}-${occurrence}`;
      const diagnostic: ModelIssueDiagnostic = {
        issueId: `issue-${identity}`, occurredAt: 1000, code: "model_reasoning_rejected", outcome: "recovered",
        profileId: "profile", providerId, provider: "openai", model: "reasoning-model", operation: "chat",
        parameter: "reasoning_effort", requestedValue: "none", recovery: "provider_default",
      };
      const encoded = encodeModelIssues([diagnostic]);
      expect(encoded).toBeTypeOf("string");
      const [decoded] = decodeModelIssues(encoded!);
      expect(decoded).toEqual(diagnostic);
      const observe = modelIssueObserver({ requestId: `request-${identity}`, invocationId: `invocation-${identity}`, modelStep: "chat",
        onEvent: (name, facts) => f.service.observe({ type: "event", name, ...facts, environment: "dev", sessionId: `session-${identity}` }),
      });
      observe({ ...decoded!, outcome: "recovered" });
      observe({ ...decoded!, outcome: "recovered" }); // Delivery replay is not another occurrence.
    }
  }
  await f.service.flush();
  const page = await f.service.list("dev");
  expect(page.unreadErrorCount).toBe(2);
  expect(page.items.map((item) => item.issue?.occurrenceCount)).toEqual([2, 2]);
  expect(new Set(page.items.map((item) => item.issue?.groupKey)).size).toBe(2);
  expect(f.deliver).not.toHaveBeenCalled();
});
