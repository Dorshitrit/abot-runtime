import { expect, test, vi } from "vitest";
import { SPARK_SESSION_ID } from "../../sessions/spark-session.js";
import { createSparkAccessFixture } from "./support/bridge-spark-fixture.js";

test("concurrent opens share the marked companion and expose only chat configuration", async () => {
  const f = createSparkAccessFixture();
  const results = await Promise.all([f.access.open(), f.access.open()]);
  expect(results).toEqual(Array(2).fill({
    sessionId: SPARK_SESSION_ID,
    modelProfileId: "spark",
    toolPermissionMode: "ask",
    readiness: "ready",
  }));
  expect((await f.sessions.listSessions()).sessions).toHaveLength(1);
  expect(await f.sessions.getSessionById(SPARK_SESSION_ID)).toMatchObject({
    kind: "spark", messages: [],
  });
  await f.sessions.appendMessage(SPARK_SESSION_ID, "user", "Keep my history");
  await f.access.open();
  expect((await f.sessions.getSessionById(SPARK_SESSION_ID))?.messages).toHaveLength(1);
});

test.each([
  [undefined, undefined, null, "model_required", "spark_chat_model_required"],
  ["learning", undefined, "learning", "ready", null],
  ["learning", "missing", "missing", "model_unavailable", "spark_chat_model_unavailable"],
] as const)("reports readiness for learning=%s and companion=%s", async (
  modelProfileId, proactiveModelProfileId, effective, readiness, error,
) => {
  const f = createSparkAccessFixture();
  f.configure({ modelProfileId, proactiveModelProfileId });
  expect(await f.access.open()).toMatchObject({ modelProfileId: effective, readiness });
  const result = f.access.resolve(SPARK_SESSION_ID, { text: "Hello" });
  if (error) {
    await expect(result).rejects.toThrow(error);
  } else {
    await expect(result).resolves.toMatchObject({ modelPreference: { profileId: effective, scope: "all" } });
  }
});

test("ordinary input retains identity and never reads or creates SPARK state", async () => {
  const f = createSparkAccessFixture();
  const read = vi.spyOn(f.sessions, "getSessionById");
  const create = vi.spyOn(f.sessions, "getOrCreateSession");
  const body = { text: "Ordinary", modelPreference: { profileId: "other" }, toolPermissionMode: "full_plus" };
  expect(await f.access.resolve("ordinary", body, { requireMatchingPermissionMode: true })).toBe(body);
  expect(f.status).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
  expect(create).not.toHaveBeenCalled();
});

test.each(["missing", "unmarked"])("never admits a %s reserved session", async (state) => {
  const f = createSparkAccessFixture();
  if (state === "unmarked") await f.sessions.getOrCreateSession(SPARK_SESSION_ID);
  const before = await f.sessions.getSessionById(SPARK_SESSION_ID);
  await expect(f.access.resolve(SPARK_SESSION_ID, { text: "Hello" }))
    .rejects.toThrow("spark_chat_session_unavailable");
  expect(await f.sessions.getSessionById(SPARK_SESSION_ID)).toEqual(before);
  expect(f.status).not.toHaveBeenCalled();
  if (state === "unmarked") {
    await expect(f.access.open()).rejects.toThrow("spark_chat_session_unavailable");
    expect(await f.sessions.getSessionById(SPARK_SESSION_ID)).toEqual(before);
  }
});

test("canonical settings replace stale client model and mode without mutating input", async () => {
  const f = createSparkAccessFixture();
  await f.access.open();
  const body = {
    requestId: "request", text: "Hello", toolPermissionMode: "full_plus",
    modelPreference: { profileId: "other", scope: "root" },
    attachments: [{ id: "attachment" }],
  };
  const before = structuredClone(body);
  expect(await f.access.resolve(SPARK_SESSION_ID, body)).toEqual({
    ...body, toolPermissionMode: "ask", modelPreference: { profileId: "spark", scope: "all" },
  });
  expect(body).toEqual(before);
});

test.each(["ask", "full_access", "full_plus"] as const)(
  "strict admission accepts only the current %s grant", async (mode) => {
    const f = createSparkAccessFixture();
    f.configure({ sparkToolPermissionMode: mode });
    await f.access.open();
    const options = { requireMatchingPermissionMode: true };
    await expect(f.access.resolve(SPARK_SESSION_ID, { toolPermissionMode: mode }, options))
      .resolves.toMatchObject({ toolPermissionMode: mode });
    for (const body of [{}, { toolPermissionMode: null }, { toolPermissionMode: "invalid" },
      { toolPermissionMode: mode === "ask" ? "full_plus" : "ask" },
      Object.create({ toolPermissionMode: mode }) as object]) {
      await expect(f.access.resolve(SPARK_SESSION_ID, body, options))
        .rejects.toThrow("spark_chat_permission_mismatch");
    }
  },
);

test("send re-reads policy and model after open instead of trusting the earlier configuration", async () => {
  const f = createSparkAccessFixture();
  expect(await f.access.open()).toMatchObject({ toolPermissionMode: "ask", modelProfileId: "spark" });
  f.configure({ sparkToolPermissionMode: "full_plus", proactiveModelProfileId: "learning" });
  await expect(f.access.resolve(SPARK_SESSION_ID, { toolPermissionMode: "ask" }, { requireMatchingPermissionMode: true }))
    .rejects.toThrow("spark_chat_permission_mismatch");
  expect(await f.access.resolve(SPARK_SESSION_ID, { toolPermissionMode: "full_plus" }, { requireMatchingPermissionMode: true }))
    .toMatchObject({ toolPermissionMode: "full_plus", modelPreference: { profileId: "learning", scope: "all" } });
  f.configure({ proactiveModelProfileId: "removed" });
  await expect(f.access.resolve(SPARK_SESSION_ID, { toolPermissionMode: "full_plus" }, { requireMatchingPermissionMode: true }))
    .rejects.toThrow("spark_chat_model_unavailable");
});

test("internal configuration failures expose no diagnostic details to chat clients", async () => {
  const f = createSparkAccessFixture();
  await f.access.open();
  f.status.mockRejectedValue(new Error("private local preference file failed"));
  await expect(f.access.open()).rejects.toThrow(/^spark_chat_unavailable$/);
  await expect(f.access.resolve(SPARK_SESSION_ID, { text: "Hello" }))
    .rejects.toThrow(/^spark_chat_unavailable$/);
});
