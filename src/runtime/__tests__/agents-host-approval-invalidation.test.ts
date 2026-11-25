import { expect, test, vi } from "vitest";
import type { AgentApplicationDetail } from "../agents/application-contracts.js";
import type { RuntimeEnvironmentServices, RuntimeRequestHandler } from "../composition.js";
import { createAgentWorkspaceHost } from "../agents/workspace-host.js";
import { projectAgentDetail } from "../agents/application-view.js";
import { delegatedApprovalFixture } from "./support/agents-approval-attention-fixture.js";

const observer = vi.hoisted(() => ({ snapshot: null as null | ((revision: number, agents: readonly AgentApplicationDetail[]) => Promise<void>) }));
vi.mock("../agents/application-observer.js", () => ({ createAgentApplicationObserver(input: { onSnapshot: typeof observer.snapshot }) {
  observer.snapshot = input.onSnapshot; return { start: async () => {}, stop: async () => {} };
} }));
vi.mock("../agents/progress-reporter.js", () => ({ createAgentProgressReporter: () => ({ observe() {}, isBusy: () => false, stop: async () => {} }) }));

test("the owner keeps invalidating an approval wait even if Agent state revision is stable", async () => {
  const changed = vi.fn();
  const services = { config: { paths: { runtimeDir: "/unused-agent-host-fixture" } }, sessions: {} } as unknown as RuntimeEnvironmentServices;
  const host = createAgentWorkspaceHost(services, {} as RuntimeRequestHandler, changed);
  const { state } = delegatedApprovalFixture();
  const waiting = projectAgentDetail(state, "parent", false);
  expect(waiting.status).toBe("awaiting_approval");
  await observer.snapshot!(9, [waiting]);
  await observer.snapshot!(9, [waiting]);
  expect(changed.mock.calls).toEqual([[9], [9]]);
  await observer.snapshot!(9, [{ ...waiting, status: "idle" }]);
  expect(changed).toHaveBeenCalledTimes(2);
  await host.stop();
});

test("cancellation during an ordinary wait read cannot publish a stale approval", async () => {
  const data = delegatedApprovalFixture();
  let state = data.state;
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const get = vi.fn(async (sessionId: string) => { await pending; return sessionId === "session-child" ? data.wait() : null; });
  const services = { config: { paths: { runtimeDir: "/unused-agent-host-fixture" } }, sessions: { requestLifecycle: { get } } } as unknown as RuntimeEnvironmentServices;
  const host = createAgentWorkspaceHost(services, {} as RuntimeRequestHandler, vi.fn());
  const read = vi.spyOn(host.store, "read").mockImplementation(async () => state);
  const page = host.projection.notifications({ attention: [], waits: [] }, 0);
  await vi.waitFor(() => expect(get).toHaveBeenCalled());
  state = { ...state, missions: state.missions.map(mission => mission.agentId === "child" ? { ...mission, status: "cancelled" as const } : mission) };
  release();
  expect((await page).entries).toEqual([]);
  expect(read).toHaveBeenCalledTimes(2);
  await host.stop();
});
