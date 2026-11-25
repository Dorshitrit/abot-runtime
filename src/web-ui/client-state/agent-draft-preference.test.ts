import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "vitest";
import { AGENT_DRAFT_PREFERENCE } from "./agent-draft-preference.js";
import { updatePreference } from "./preferences.js";
import { createAgentDraftCleanup } from "./session-reset.js";
import { WebClientStateStore } from "./store.js";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const scope = (agent: string) => JSON.stringify(["dev", agent]);
const draft = (text: string, pendingId = "") => ({ text, pendingId, intent: "auto", onboarding: "" });
const mutate = (preferences: Record<string, string>, before: unknown, value: unknown) => updatePreference(preferences, { key: AGENT_DRAFT_PREFERENCE, before: before === null ? null : JSON.stringify(before), value: JSON.stringify(value) });

describe("Agent draft atomic preference merge", () => {
  test("different windows cannot combine a new message with an older receipt", () => {
    const key = scope("a"), before = { [key]: draft("First") }, preferences = { [AGENT_DRAFT_PREFERENCE]: JSON.stringify(before) };
    mutate(preferences, before, { [key]: draft("First", "receipt-1") });
    expect(() => mutate(preferences, before, { [key]: draft("Next") })).toThrow(/another window/);
    expect(JSON.parse(preferences[AGENT_DRAFT_PREFERENCE]!)[key]).toEqual(draft("First", "receipt-1"));
  });
  test("independent Agent scopes still merge and unrelated preferences retain field merging", () => {
    const before = { [scope("a")]: draft("A"), [scope("b")]: draft("B") }, preferences = { [AGENT_DRAFT_PREFERENCE]: JSON.stringify(before) };
    mutate(preferences, before, { ...before, [scope("a")]: draft("A", "receipt-a") });
    mutate(preferences, before, { ...before, [scope("b")]: draft("B updated") });
    expect(JSON.parse(preferences[AGENT_DRAFT_PREFERENCE]!)).toEqual({ [scope("a")]: draft("A", "receipt-a"), [scope("b")]: draft("B updated") });
    const key = "abot-web.sessionSidebarByEnvironment", old = { dev: { archivedSessionIds: [], orderedSessionIds: [] } }, other = { [key]: JSON.stringify(old) };
    updatePreference(other, { key, before: JSON.stringify(old), value: JSON.stringify({ dev: { archivedSessionIds: ["one"], orderedSessionIds: [] } }) });
    updatePreference(other, { key, before: JSON.stringify(old), value: JSON.stringify({ dev: { archivedSessionIds: [], orderedSessionIds: ["two"] } }) });
    expect(JSON.parse(other[key]!)).toEqual({ dev: { archivedSessionIds: ["one"], orderedSessionIds: ["two"] } });
  });
  test("agent deletion erases only the selected owner after reload, including recovery and saved configuration", async () => {
    const root = await mkdtemp(join(tmpdir(), "abot-delete-drafts-")); roots.push(root);
    const store = new WebClientStateStore(root);
    const keep = {
      [scope("a2")]: draft("Other agent"), [JSON.stringify(["prod", "a"])]: draft("Other environment"), [scope("$new")]: draft("New"),
      [scope("$legacy-coordinator-backup:abot%3Aedit:b")]: draft("Unrelated backup"),
    };
    const before = { ...keep, [scope("a")]: draft("Private", "pending"), [scope("a:onboarding")]: draft("Settings"),
      [scope("a:schedule")]: draft("Schedule"), [scope("$legacy-coordinator-backup:a%3Aedit:b")]: draft("Private backup") };
    await store.transaction(state => mutate(state.preferences, null, before));
    const cleanup = createAgentDraftCleanup(root);
    await cleanup("dev", "a");
    await cleanup("dev", "a");
    const result = await new WebClientStateStore(root).transaction(state => state.preferences[AGENT_DRAFT_PREFERENCE]);
    expect(JSON.parse(result.result!)).toEqual(keep);
    expect(result.state.revision).toBe(2);
    await expect(store.transaction(state => mutate(state.preferences, before, { ...before, [scope("a")]: draft("Stale") }))).rejects.toThrow(/another window/);
  });
  test("a pending receipt reloads from disk and rejects a stale clear after a new draft", async () => {
    const root = await mkdtemp(join(tmpdir(), "abot-agents-draft-")); roots.push(root);
    const before = { [scope("a")]: draft("First", "receipt-1") }, store = new WebClientStateStore(root);
    await store.transaction((state) => mutate(state.preferences, null, before));
    const reloaded = new WebClientStateStore(root);
    const loaded = await reloaded.transaction((state) => state.preferences[AGENT_DRAFT_PREFERENCE]);
    expect(JSON.parse(loaded.result!)).toEqual(before);
    await reloaded.transaction((state) => mutate(state.preferences, before, { [scope("a")]: draft("Next") }));
    await expect(store.transaction((state) => mutate(state.preferences, before, {}))).rejects.toThrow(/another window/);
    const retained = await new WebClientStateStore(root).transaction((state) => state.preferences[AGENT_DRAFT_PREFERENCE]);
    expect(JSON.parse(retained.result!)[scope("a")]).toEqual(draft("Next"));
  });
});
