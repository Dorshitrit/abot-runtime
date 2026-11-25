import { expect, test, vi } from "vitest";
import { agentsScheduleFixture } from "./support/agents-schedule-fixture.js";

test("a late claimed schedule cannot dispatch or settle a different owner's replacement", async () => {
  const f = await agentsScheduleFixture();
  try {
    await f.service.create(f.input);
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const claimed = new Promise<void>(resolve => { entered = resolve; });
    f.get.mockImplementation(async () => {
      if (f.get.mock.calls.length === 3) { entered(); await blocked; }
      return structuredClone(f.detail());
    });
    f.advance(1000);
    const tick = f.service.tick();
    await claimed;
    await f.service.removeForAgent("agent-a");
    const replacement = await f.service.create({...f.input, agentId:"other-agent", startAt:new Date(f.now() + 10_000).toISOString()});
    release(); await tick;
    expect(f.send).not.toHaveBeenCalled();
    expect(await f.service.list()).toEqual([replacement]);
    await expect(f.service.cancel(replacement.id, replacement.revision, "agent-a")).rejects.toThrow("agents_schedule_not_found");
    await expect(f.service.update(replacement.id, replacement.revision, replacement, "agent-a")).rejects.toThrow("agents_schedule_not_found");
    expect(await f.service.list()).toEqual([replacement]);
  } finally { await f.dispose(); }
});

test("a schedule create which already read the active agent is removed before deletion returns", async () => {
  const f = await agentsScheduleFixture();
  try {
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    f.get.mockImplementationOnce(async () => { const observed = structuredClone(f.detail()); await blocked; return observed; });
    const creating = f.service.create(f.input);
    await vi.waitFor(() => expect(f.get).toHaveBeenCalledOnce());
    const deleting = f.another().removeForAgent("agent-a");
    const detail = f.detail();
    f.setDetail({...detail, agent:{...detail.agent, status:"archived"}});
    release();
    await Promise.all([creating, deleting]);
    expect(await f.service.list()).toEqual([]);
    await expect(f.service.create({...f.input, id:"other"})).rejects.toThrow("agents_agent_not_active");
  } finally { await f.dispose(); }
});
