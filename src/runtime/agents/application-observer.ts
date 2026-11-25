import { hasAgentWorkToReconcile } from "./work-reconciliation.js";
import type { AgentApplicationDetail, AgentApplicationService } from "./application-contracts.js";

/** Poll existing receipts only. Continuation is owned by the already accepted mission. */
export function createAgentApplicationObserver(input: {
  application: Pick<AgentApplicationService, "snapshot" | "refresh">;
  onSnapshot?: (revision: number, agents: readonly AgentApplicationDetail[]) => Promise<void>;
  runTick?: (operation: () => Promise<void>) => Promise<void>;
  onError?: (error: unknown) => void;
}) {
  let timer: ReturnType<typeof setInterval> | undefined;
  let pending: Promise<void> | undefined;
  let stopped = true, errorReported = false;
  async function tick(): Promise<void> {
    if (stopped) return;
    if (pending) return pending;
    const inspect = async () => {
      const snapshot = await input.application.snapshot();
      for (const detail of snapshot.agents) {
        if (stopped) return;
        if (hasAgentWorkToReconcile(detail))
          await input.application.refresh(detail.agent.id);
      }
      if (!stopped) await input.onSnapshot?.(snapshot.revision, snapshot.agents);
      errorReported = false;
    };
    const task = input.runTick ? input.runTick(inspect) : inspect();
    pending = task;
    try { await task; }
    catch (error) { if (!errorReported) input.onError?.(error); errorReported = true; }
    finally { if (pending === task) pending = undefined; }
  }
  return {
    async start(): Promise<void> {
      if (!stopped) return;
      stopped = false;
      timer = setInterval(() => { void tick(); }, 1000); timer.unref?.();
      await tick();
    },
    async stop(): Promise<void> { stopped = true; if (timer) clearInterval(timer); timer = undefined; await pending?.catch(() => undefined); },
    tick,
  };
}
