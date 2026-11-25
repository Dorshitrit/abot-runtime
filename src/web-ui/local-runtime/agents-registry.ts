import { createAgentAttentionObserver } from "./agent-attention-notifications.js";
import { createAgentReplyObserver, type AgentNotificationInbox } from "./agent-chat-notifications.js";
import type { RuntimeEnvironment } from "./contracts.js";

type ForgetOwnedData = (environmentId: string, id: string) => Promise<void>;

/** One Web projection per attached environment. Agent execution belongs to the managed owner. */
async function attachAgentEnvironment(environment: RuntimeEnvironment, id: string, inbox?: AgentNotificationInbox,
  forgetSession?: ForgetOwnedData, forgetDrafts?: ForgetOwnedData) {
  const workspace = environment.agents;
  const publish = inbox && createAgentReplyObserver(id, inbox);
  const publishWaits = inbox && workspace.projection.notifications && createAgentAttentionObserver(id, inbox);
  let tail = Promise.resolve();
  let closed = false;
  let queued = false;
  let retry: ReturnType<typeof setTimeout> | undefined;

  async function reconcile() {
    await publish?.(workspace.projection.attention);
    if (publishWaits && workspace.projection.notifications) await publishWaits(workspace.projection.notifications);
    for (const receipt of await workspace.projection.pending()) {
      for (const sessionId of receipt.sessionIds) await forgetSession?.(id, sessionId);
      await inbox?.forgetAgentReplies(id, receipt.agentId);
      await forgetDrafts?.(id, receipt.agentId);
      // A Web instance without all three persistent stores cannot finish another instance's cleanup.
      if (inbox && forgetDrafts && forgetSession) await workspace.projection.acknowledge(receipt.agentId);
    }
  }
  function sync(): Promise<void> {
    if (closed) return Promise.reject(new Error("agents_environment_reloading"));
    if (queued) return tail;
    queued = true;
    tail = tail.catch(() => {}).then(() => {
      queued = false;
      return reconcile();
    });
    return tail;
  }
  function changed(_revision: number) {
    // A new ordinary wait can invalidate the view without changing Agent state.
    if (closed) return;
    void sync().catch(() => {
      if (closed || retry) return;
      retry = setTimeout(() => { retry = undefined; changed(-2); }, 5000);
      retry.unref?.();
      console.error("Agent Web projection needs attention.");
    });
  }
  const unsubscribe = environment.subscribeAgentEvents(changed);
  async function detach() {
    closed = true;
    if (retry) clearTimeout(retry);
    unsubscribe();
    await tail.catch(() => {});
  }
  try { await sync(); }
  catch (error) { await detach(); throw error; }
  return { local: workspace.local, projection: { through: workspace.projection.through }, isBusy: workspace.isBusy, sync, detach };
}
export type WebAgentEnvironment = Awaited<ReturnType<typeof attachAgentEnvironment>>;

export class WebAgentRegistry {
  private retiring = false;
  private readonly entries = new Map<string, { environment: RuntimeEnvironment; ready: Promise<WebAgentEnvironment> }>();
  constructor(private readonly environment: (id: string) => RuntimeEnvironment, private readonly inbox?: AgentNotificationInbox,
    private readonly forgetSession?: ForgetOwnedData, private readonly forgetDrafts?: ForgetOwnedData) {}

  async get(id: string): Promise<WebAgentEnvironment> {
    if (this.retiring) throw new Error("agents_environment_reloading");
    const environment = this.environment(id);
    const existing = this.entries.get(id);
    if (existing?.environment === environment) return existing.ready;
    const ready = (async () => {
      if (existing) await (await existing.ready).detach();
      return attachAgentEnvironment(environment, id, this.inbox, this.forgetSession, this.forgetDrafts);
    })();
    this.entries.set(id, { environment, ready });
    try { return await ready; }
    catch (error) { if (this.entries.get(id)?.ready === ready) this.entries.delete(id); throw error; }
  }
  async isBusy(): Promise<boolean> {
    for (const entry of this.entries.values()) {
      if (await (await entry.ready).isBusy()) return true;
    }
    return false;
  }
  async reconfigure<T>(apply: () => Promise<T>): Promise<T> {
    const ids = [...this.entries.keys()];
    this.retiring = true;
    try { await this.stop(); return await apply(); }
    finally {
      this.retiring = false;
      for (const id of ids) await this.get(id).catch(() => { console.error(`Agent workspace unavailable after configuration change: ${id}.`); });
    }
  }
  async stop(): Promise<void> {
    const entries = [...this.entries.values()];
    this.entries.clear();
    await Promise.all(entries.map(async entry => (await entry.ready).detach()));
  }
}
