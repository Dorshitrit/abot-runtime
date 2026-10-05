import { afterEach, describe, expect, test, vi } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { createFileSessionStore } from "../adapters/file-session-store.js";
import { createInMemorySessionStore } from "../adapters/in-memory-session-store.js";
import { createSessionLifecycleStore } from "../session/session-lifecycle-store.js";
import { ensureSparkSession, SPARK_SESSION_ID } from "../../sessions/spark-session.js";
import { createRequestSessionMemory } from "../context/session-memory/index.js";
import { projectRequestContext } from "../context/request-context.js";
import type { CreateAssistantConversationInput } from "../../sessions/assistant-initiative.js";
import type { SessionStore } from "../ports.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fileStore() {
  const parent = join(process.cwd(), ".codex/artifacts/spark-companion-runtime-20261001");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "session-")); roots.push(root);
  return { root, store: createSessionLifecycleStore(createFileSessionStore({ sessionsDir: root })).store };
}

function proposal(id: string): CreateAssistantConversationInput {
  return { title: "A possible next step", content: `Would you like help with ${id}?`,
    initiative: { kind: "proactive_proposal_v1", proposalId: id, reason: "A tentative interest",
      sources: [{ kind: "candidate", id: "interest", version: "1" }] } };
}

describe.each(["file", "memory"])("SPARK canonical %s session", (adapter) => {
  async function fixture(): Promise<SessionStore> {
    if (adapter === "file") return (await fileStore()).store;
    return createSessionLifecycleStore(createInMemorySessionStore()).store;
  }

  test("concurrent clients create one marked session independent of its title", async () => {
    const store = await fixture();
    const results = await Promise.all(Array.from({ length: 8 }, () => ensureSparkSession(store)));
    expect(new Set(results.map(({ id }) => id))).toEqual(new Set([SPARK_SESSION_ID]));
    await store.updateSessionTitle(SPARK_SESSION_ID, "My companion");
    expect(await ensureSparkSession(store)).toMatchObject({ id: SPARK_SESSION_ID, kind: "spark", title: "My companion" });
    expect((await store.listSessions()).sessions).toMatchObject([{ id: SPARK_SESSION_ID, kind: "spark" }]);
    expect(await store.getSessionSnapshot(SPARK_SESSION_ID)).toMatchObject({ kind: "spark" });
  });

  test("distinct proposals append once and keep ordinary conversation history", async () => {
    const store = await fixture();
    await ensureSparkSession(store);
    await store.appendMessage(SPARK_SESSION_ID, "user", "Hello");
    await Promise.all([store.appendAssistantInitiative!(SPARK_SESSION_ID, proposal("one")),
      store.appendAssistantInitiative!(SPARK_SESSION_ID, proposal("two")),
      store.appendAssistantInitiative!(SPARK_SESSION_ID, proposal("one"))]);
    const session = (await store.getSessionById(SPARK_SESSION_ID))!;
    expect(session.messages.map(({ role }) => role)).toEqual(["user", "assistant", "assistant"]);
    expect(session.messages.map(({ initiative }) => initiative?.proposalId)).toEqual([undefined, "one", "two"]);
    expect(session.messageCount).toBe(3);
    expect((await store.listSessions()).sessions).toHaveLength(1);
  });

  test("clear keeps the identity while removing derived conversation context", async () => {
    const store = await fixture();
    await store.appendAssistantInitiative!(SPARK_SESSION_ID, proposal("one"));
    await store.appendContextEntry!(SPARK_SESSION_ID, { kind: "tool_observation", content: "old evidence",
      observationMeta: { kind: "stable_fact", carryPolicy: "always" } });
    await store.upsertArtifactPaths!(SPARK_SESSION_ID, [{ target: "old.txt", sourceRequestId: "old", sourceExecutionId: "old" }]);
    await store.clearSessionMessages(SPARK_SESSION_ID);
    expect(await ensureSparkSession(store)).toMatchObject({ id: SPARK_SESSION_ID, kind: "spark", messages: [],
      requests: [], contextEntries: [], artifactPaths: [] });
    await store.appendAssistantInitiative!(SPARK_SESSION_ID, proposal("new"));
    expect((await store.getSessionById(SPARK_SESSION_ID))?.messages).toHaveLength(1);
  });

  test("identity is never inferred from title and refuses to adopt an existing ordinary session", async () => {
    const store = await fixture();
    await store.getOrCreateSession("ordinary");
    await store.updateSessionTitle("ordinary", "ABot SPARK");
    expect((await store.getSessionById("ordinary"))?.kind).toBeUndefined();
    await expect(store.getOrCreateSession("ordinary", { kind: "spark" })).rejects.toThrow("binding_immutable");
    await expect(store.getOrCreateSession("another", { kind: "spark" })).rejects.toThrow("identity_invalid");
    await store.getOrCreateSession(SPARK_SESSION_ID);
    await expect(ensureSparkSession(store)).rejects.toThrow("binding_immutable");
    await expect(store.appendAssistantInitiative!(SPARK_SESSION_ID, proposal("one"))).rejects.toThrow("binding_immutable");
  });
});

test("environment directories retain independent SPARK history across adapter restart", async () => {
  const first = await fileStore(); const second = await fileStore();
  await first.store.appendAssistantInitiative!(SPARK_SESSION_ID, proposal("first"));
  await ensureSparkSession(second.store);
  const restarted = createFileSessionStore({ sessionsDir: first.root });
  expect((await ensureSparkSession(restarted)).messages).toHaveLength(1);
  expect((await ensureSparkSession(second.store)).messages).toEqual([]);
});

test("post-commit invalidation restores existing SPARK messages rather than deleting the session", async () => {
  const { store } = await fileStore();
  await ensureSparkSession(store);
  const before = await store.appendMessage(SPARK_SESSION_ID, "user", "Keep my conversation");
  let checks = 0;
  await expect(store.appendAssistantInitiative!(SPARK_SESSION_ID, { ...proposal("cancelled"), assertCurrent() {
    if (++checks === 4) throw new Error("proactive_superseded");
  } })).rejects.toThrow("proactive_superseded");
  expect(await store.getSessionById(SPARK_SESSION_ID)).toEqual(before);
});

test("a user reply sees proposals only as assistant history and clear cannot resurrect it", async () => {
  const { store } = await fileStore();
  const session = await store.appendAssistantInitiative!(SPARK_SESSION_ID, proposal("one"));
  const memory = createRequestSessionMemory({ sessionId: session.id, session,
    repository: store, compactor: { compact: vi.fn(async () => "unused") } });
  const context = projectRequestContext({ instructions: "Existing chat policy", ...memory.project(), prompt: "Yes, help me",
    budget: { contextWindowTokens: 10000, outputReserveTokens: 1000, safetyReserveTokens: 100, attachmentReserveTokens: 0 } });
  expect(context.messages.filter(({ role }) => role === "user")).toEqual([{ role: "user", content: "Yes, help me" }]);
  expect(context.messages.filter(({ role }) => role === "assistant")).toEqual([{ role: "assistant", content: proposal("one").content }]);
  await store.clearSessionMessages(session.id);
  const reset = createRequestSessionMemory({ sessionId: session.id, session: (await store.getSessionById(session.id))!,
    repository: store, compactor: { compact: vi.fn(async () => "unused") } });
  expect(reset.project().historyMessages).toEqual([]);
});
