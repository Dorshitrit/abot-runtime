import { expect, test, vi } from "vitest";
// @ts-expect-error Browser-only controller has no declaration surface.
import { createKnowledgeCandidateActions } from "../../web-ui/app/controllers/knowledge-candidate-actions.js";
// @ts-expect-error Browser-only native view has no declaration surface.
import { candidateActionsMarkup, confirmKnowledgeCandidateAction } from "../../web-ui/app/components/passive-learning/candidate-actions.js";
// @ts-expect-error Browser-only controller has no declaration surface.
import { createPassiveLearningController } from "../../web-ui/app/controllers/passive-learning-controller.js";

const candidate = { id: "candidate", revision: 2, content: "Prefers tea." };
const binding = { id: candidate.id, revision: candidate.revision, environmentId: "dev" };
function fixture() {
  let environment = "dev";
  let ready = true;
  let candidates = [candidate];
  const client = { promoteLearningCandidate: vi.fn(async (_input: unknown) => ({ record: { id: "saved" } })),
    deleteLearningCandidate: vi.fn(async (_input: unknown) => ({ deleted: true })) };
  const onCommitted = vi.fn();
  const actions = createKnowledgeCandidateActions({ client, getEnvironmentId: () => environment,
    getCandidates: () => candidates, isRuntimeReady: () => ready, onChange: vi.fn(), onCommitted });
  return { client, actions, onCommitted, setCandidates: (value: typeof candidates) => { candidates = value; },
    setReady(value: boolean) { ready = value; },
    setEnvironment(value: string) { environment = value; actions.reset(); } };
}

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test("candidate actions send only current exact identity and environment, and publish confirmed changes", async () => {
  const f = fixture();
  await f.actions.promoteCandidate({ ...binding, revision: 1 });
  await f.actions.deleteCandidate({ ...binding, environmentId: "other" });
  expect(f.client.promoteLearningCandidate).not.toHaveBeenCalled();
  expect(f.client.deleteLearningCandidate).not.toHaveBeenCalled();
  await f.actions.promoteCandidate(binding);
  expect(f.client.promoteLearningCandidate).toHaveBeenCalledWith(binding);
  expect(f.onCommitted).toHaveBeenCalledWith({ ...binding, action: "promote", result: { record: { id: "saved" } } });
  expect(f.actions.snapshot()).toMatchObject({ pendingCandidateId: "", candidateActionError: "" });
});

test("duplicate clicks are blocked and old-environment completions cannot update a new widget or Knowledge view", async () => {
  const f = fixture();
  let resolve!: (value: { deleted: boolean }) => void;
  f.client.deleteLearningCandidate.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const pending = f.actions.deleteCandidate(binding);
  expect(f.actions.snapshot()).toMatchObject({ pendingCandidateId: "candidate", pendingCandidateAction: "delete" });
  await f.actions.deleteCandidate(binding);
  expect(f.client.deleteLearningCandidate).toHaveBeenCalledOnce();
  f.setEnvironment("other");
  resolve({ deleted: true });
  await pending;
  expect(f.onCommitted).not.toHaveBeenCalled();
  expect(f.actions.snapshot()).toMatchObject({ pendingCandidateId: "", candidateActionError: "" });
});

test.each(["promote", "delete"])("an admitted %s settles while inactive and releases pending state", async action => {
  const f = fixture();
  const pendingResponse = gate();
  f.client.promoteLearningCandidate.mockImplementationOnce(async () => { await pendingResponse.promise; return { record: { id: "saved" } }; });
  f.client.deleteLearningCandidate.mockImplementationOnce(async () => { await pendingResponse.promise; return { deleted: true }; });
  const run = action === "promote" ? f.actions.promoteCandidate : f.actions.deleteCandidate;
  const request = action === "promote" ? f.client.promoteLearningCandidate : f.client.deleteLearningCandidate;
  const result = action === "promote" ? { record: { id: "saved" } } : { deleted: true };
  const pending = run(binding);
  f.setReady(false);
  pendingResponse.resolve();
  await expect(pending).resolves.toEqual(result);
  expect(f.onCommitted).toHaveBeenCalledWith({ ...binding, action, result });
  expect(f.actions.snapshot()).toEqual({ pendingCandidateId: "", pendingCandidateAction: "", candidateActionError: "" });
  const next = { ...candidate, id: "next" };
  f.setCandidates([next]);
  await run({ ...binding, id: next.id });
  expect(request).toHaveBeenCalledOnce();
  f.setReady(true);
  await run({ ...binding, id: next.id });
  expect(request).toHaveBeenCalledTimes(2);
  expect(f.onCommitted).toHaveBeenCalledTimes(2);
});

test.each(["promote", "delete"])("an admitted %s failure clears pending state while inactive without replay", async action => {
  const f = fixture();
  const pendingResponse = gate();
  const fail = async () => { await pendingResponse.promise; throw new Error("long_term_memory_management_conflict"); };
  f.client.promoteLearningCandidate.mockImplementationOnce(fail);
  f.client.deleteLearningCandidate.mockImplementationOnce(fail);
  const run = action === "promote" ? f.actions.promoteCandidate : f.actions.deleteCandidate;
  const request = action === "promote" ? f.client.promoteLearningCandidate : f.client.deleteLearningCandidate;
  const pending = run(binding);
  f.setReady(false); pendingResponse.resolve(); await pending;
  expect(f.actions.snapshot()).toMatchObject({ pendingCandidateId: "", pendingCandidateAction: "" });
  expect(f.actions.snapshot().candidateActionError).toContain("changed");
  expect(f.onCommitted).not.toHaveBeenCalled();
  await run(binding);
  expect(request).toHaveBeenCalledOnce();
  f.setReady(true);
  await run(binding);
  expect(request).toHaveBeenCalledTimes(2);
  expect(f.actions.snapshot().candidateActionError).toBe("");
});

test("a reset keeps an old settlement from clearing a newer operation in the same environment", async () => {
  const f = fixture();
  const first = gate(); const second = gate();
  f.client.promoteLearningCandidate.mockImplementationOnce(async () => { await first.promise; return { record: { id: "saved" } }; });
  f.client.deleteLearningCandidate.mockImplementationOnce(async () => { await second.promise; return { deleted: true }; });
  const old = f.actions.promoteCandidate(binding);
  f.actions.reset();
  const current = f.actions.deleteCandidate(binding);
  first.resolve(); await old;
  expect(f.onCommitted).not.toHaveBeenCalled();
  expect(f.actions.snapshot()).toMatchObject({ pendingCandidateId: "candidate", pendingCandidateAction: "delete" });
  second.resolve(); await current;
  expect(f.onCommitted).toHaveBeenCalledOnce();
  expect(f.actions.snapshot().pendingCandidateId).toBe("");
});

test("a server conflict keeps the candidate and exposes actionable feedback", async () => {
  const f = fixture();
  f.client.promoteLearningCandidate.mockRejectedValueOnce(new Error("long_term_memory_management_conflict"));
  await f.actions.promoteCandidate(binding);
  expect(f.onCommitted).not.toHaveBeenCalled();
  expect(f.actions.snapshot().candidateActionError).toContain("changed");
  expect(f.actions.snapshot().pendingCandidateId).toBe("");
});

test("a failed refresh after a confirmed mutation does not claim the save failed", async () => {
  const f = fixture();
  f.onCommitted.mockRejectedValueOnce(new Error("refresh_failed"));
  await expect(f.actions.promoteCandidate(binding)).resolves.toEqual({ record: { id: "saved" } });
  expect(f.actions.snapshot().candidateActionError).toContain("was saved");
  expect(f.client.promoteLearningCandidate).toHaveBeenCalledOnce();
});

test("native confirmation distinguishes replacement from creation and sends no mutation on rejection or scope change", async () => {
  const actions = { promoteCandidate: vi.fn(), deleteCandidate: vi.fn() };
  const confirm = vi.fn(async () => false);
  const replacement = { ...candidate, replacement: { id: "existing", version: "2026-11-02T10:00:00Z" } };
  const input = { candidate: replacement, action: "promote", environmentId: "dev", actions, isCurrent: () => true, confirm };
  await confirmKnowledgeCandidateAction(input);
  expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Replace the existing memory"), expect.objectContaining({ title: "Update existing memory" }));
  expect(actions.promoteCandidate).not.toHaveBeenCalled();
  confirm.mockResolvedValue(true);
  await confirmKnowledgeCandidateAction({ ...input, isCurrent: () => false });
  expect(actions.promoteCandidate).not.toHaveBeenCalled();
  await confirmKnowledgeCandidateAction(input);
  expect(actions.promoteCandidate).toHaveBeenCalledWith(binding);
  expect(candidateActionsMarkup(replacement)).toContain("Update memory");
  expect(candidateActionsMarkup(candidate)).toContain("Save to memory");
  expect(candidateActionsMarkup({ ...candidate, revision: undefined })).toBe("");
});

test("Knowledge removes only the confirmed candidate, refreshes status, and retains candidates on failed deletion", async () => {
  const client = {
    loadPassiveLearning: vi.fn(async () => ({ status: { preferences: { enabled: false } } })),
    listPassiveLearningCandidates: vi.fn(async () => ({ items: [candidate] })),
    listPassiveLearningBatches: vi.fn(async () => ({ items: [] })), listModels: vi.fn(async () => ({ profiles: [] })),
    promoteLearningCandidate: vi.fn(async () => ({ record: { id: "saved" } })),
    deleteLearningCandidate: vi.fn(async () => { throw new Error("storage_failed"); }),
  };
  const controller = createPassiveLearningController({ client, getEnvironmentId: () => "dev", render: vi.fn(), isVisible: () => true });
  controller.setWorkspace("learning");
  await vi.waitFor(() => expect(controller.snapshot().candidates).toEqual([candidate]));
  await controller.deleteCandidate(binding);
  expect(controller.snapshot().candidates).toEqual([candidate]);
  client.listPassiveLearningCandidates.mockResolvedValue({ items: [] });
  await controller.promoteCandidate(binding);
  await vi.waitFor(() => expect(controller.snapshot().candidates).toEqual([]));
  expect(client.loadPassiveLearning.mock.calls.length).toBeGreaterThan(1);
});
