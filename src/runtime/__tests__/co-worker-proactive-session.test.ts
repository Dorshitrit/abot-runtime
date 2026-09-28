import { afterEach, describe, expect, test, vi } from "vitest";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { createFileSessionStore } from "../adapters/file-session-store.js";
import { createSessionLifecycleStore } from "../session/session-lifecycle-store.js";
import { createRequestSessionMemory } from "../context/session-memory/index.js";
import { projectRequestContext } from "../context/request-context.js";
import { snapshotSessionMemorySource } from "../../sessions/memory/source.js";
import type { CreateAssistantConversationInput } from "../../sessions/assistant-initiative.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const parent = join(process.cwd(), ".codex/artifacts/co-worker-proactive-session-tests");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "fixture-")); roots.push(root);
  return { root, store: createSessionLifecycleStore(createFileSessionStore({ sessionsDir: root })).store };
}
function proposal(): CreateAssistantConversationInput {
  return { title: "A possible next step", content: "Would you like me to research train options for the trip?",
    initiative: { kind: "proactive_proposal_v1", proposalId: "proposal-1", reason: "A tentative upcoming trip",
      sources: [{ kind: "candidate", id: "trip", version: "2" }] } };
}

describe("proactive conversation persistence and continuity", () => {
  test("creates exactly one assistant-origin conversation and replays by proposal identity", async () => {
    const { root, store } = await fixture();
    const first = await store.createAssistantConversation!("co-worker-proposal-1", proposal());
    const replay = await createFileSessionStore({ sessionsDir: root }).createAssistantConversation!(first.id, proposal());
    expect(replay).toEqual(first);
    expect(first.messages).toHaveLength(1);
    expect(first.messages[0]).toMatchObject({ role: "assistant", source: "co_worker", initiative: proposal().initiative });
    expect(first.messages.some(({ role }) => role === "user")).toBe(false);
    expect((await store.getSessionSnapshot(first.id))?.messages[0]).toMatchObject({ initiative: proposal().initiative });
    expect((await store.listSessions()).sessions).toHaveLength(1);
  });

  test("rejects a different proposal identity and never resurrects a deleted session", async () => {
    const { store } = await fixture();
    await store.createAssistantConversation!("initiative", proposal());
    await expect(store.createAssistantConversation!("initiative", { ...proposal(),
      initiative: { ...proposal().initiative, proposalId: "other" } })).rejects.toThrow("identity_conflict");
    await store.deleteSession("initiative");
    await expect(store.createAssistantConversation!("initiative", proposal())).rejects.toThrow("deleted");
    expect(await store.getSessionById("initiative")).toBeNull();
  });

  test("rechecks cancellation at the durable commit and removes the temporary file", async () => {
    const { root, store } = await fixture();
    let checks = 0;
    await expect(store.createAssistantConversation!("cancelled", { ...proposal(), assertCurrent() {
      if (++checks === 3) throw new Error("disabled");
    } })).rejects.toThrow("disabled");
    expect(await store.getSessionById("cancelled")).toBeNull();
    expect(await readdir(root)).toEqual([]);
  });

  test("invalidating a replay does not delete the already existing conversation", async () => {
    const { store } = await fixture();
    const first = await store.createAssistantConversation!("existing", proposal());
    let checks = 0;
    await expect(store.createAssistantConversation!(first.id, { ...proposal(), assertCurrent() {
      if (++checks === 2) throw new Error("superseded");
    } })).rejects.toThrow("superseded");
    expect(await store.getSessionById(first.id)).toEqual(first);
  });

  test("a brief user reply sees the exact proposal as assistant history, never as user intent", async () => {
    const { store } = await fixture();
    const session = await store.createAssistantConversation!("initiative", proposal());
    const memory = createRequestSessionMemory({ sessionId: session.id, session,
      repository: store, compactor: { compact: vi.fn(async () => "unused") } });
    const projection = memory.project();
    expect(projection.historyMessages).toMatchObject([{ role: "assistant", content: proposal().content }]);
    const context = projectRequestContext({ instructions: "Existing chat rules", ...projection, prompt: "Yes, research it",
      budget: { contextWindowTokens: 10000, outputReserveTokens: 1000, safetyReserveTokens: 100, attachmentReserveTokens: 0 } });
    expect(context.messages.filter(({ role }) => role === "user")).toEqual([{ role: "user", content: "Yes, research it" }]);
    expect(context.messages.filter(({ role }) => role === "assistant")).toEqual([{ role: "assistant", content: proposal().content }]);
    const changed = { ...session, messages: session.messages.map((message) => ({ ...message,
      initiative: { ...proposal().initiative, sources: [{ kind: "candidate" as const, id: "trip", version: "3" }] } })) };
    expect(snapshotSessionMemorySource(changed).sourceRevision).not.toBe(snapshotSessionMemorySource(session).sourceRevision);
  });

  test("unbound orphan assistants and tool observations remain excluded", async () => {
    const { store } = await fixture();
    const session = await store.createAssistantConversation!("initiative", proposal());
    const original = session.messages[0]!;
    expect(snapshotSessionMemorySource({ messages: [{ ...original, source: "request", initiative: undefined }] }).turns).toEqual([]);
    expect(snapshotSessionMemorySource({ messages: [{ ...original, grounding: "tool_observation" }] }).turns).toEqual([]);
  });
});
