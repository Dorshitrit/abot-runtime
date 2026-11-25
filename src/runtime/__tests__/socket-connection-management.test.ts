import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentBridgeConnectionStatus } from "../../bridge/start-agent-bridge.js";
import type { RuntimeConfig } from "../ports.js";
import { createSocketConnectionService, type SocketConnectionTransport } from "../socket-connection/service.js";
import { withSocketConnectionManagement } from "../socket-connection/offline.js";
import { createLocalRuntimeApplication } from "../local-application.js";
import { createEnvironmentPathsFixture } from "./support/environment-paths-fixture.js";

const bundle = { runtimeId: "MacStudio", agentBridgeUrl: "wss://example.test/agent-bridge", runtimeToken: "x".repeat(43) };
const legacy = { runtimeId: "dev", url: bundle.agentBridgeUrl, token: "legacy-fixture" };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function fixture() {
  const f = await createEnvironmentPathsFixture({ default: "prod", profiles: { prod: {}, dev: {} } });
  cleanups.push(f.dispose);
  return f;
}
function managed(config: RuntimeConfig) {
  let live: AgentBridgeConnectionStatus | undefined;
  const transport = {
    start: vi.fn(() => {live = { runtimeId: bundle.runtimeId, url: bundle.agentBridgeUrl, connectionId: 1, state: "open", registered: false, reconnectAttempt: 0 };}),
    pause: vi.fn(async () => {live=undefined;}),
    stop: vi.fn(async () => {live=undefined;}),
    getStatus: () => live,
    fence: vi.fn<SocketConnectionTransport["fence"]>(() => () => {}),
  };
  const service = createSocketConnectionService(config, transport);
  cleanups.push(service.stop);
  return { service, api:service.management, transport, setLive(update: Partial<AgentBridgeConnectionStatus>) {Object.assign(live!, update);} };
}
it("previews safely, requires explicit alias approval and restores durable intent independently of legacy", async () => {
  const f = await fixture(), config = f.load("prod");
  const a = managed(config);
  expect(await a.api.preview(bundle)).toEqual({ localEnvironmentId:"prod", remoteRuntimeId:"MacStudio", serverOrigin:"wss://example.test", bindingConfirmationRequired:true });
  expect(a.transport.start).not.toHaveBeenCalled();
  await expect(a.api.import({bundle, expectedRevision:0})).rejects.toThrow("socket_connection_binding_confirmation_required");
  for (const invalid of [{...bundle,runtimeToken:"not-a-grant"},{code:"123456"}, {...bundle,agentBridgeUrl:"ws://example.test/path"},{...bundle,secret:"unrecognized"}]) {
    await expect(a.api.preview(invalid)).rejects.toThrow("socket_connection_bundle_invalid");
  }
  await a.api.import({bundle,confirmBinding:true,expectedRevision:0});
  expect(a.transport.start.mock.calls[0]).toEqual([{runtimeId:"MacStudio",url:bundle.agentBridgeUrl,token:bundle.runtimeToken},true]);
  expect(await a.api.status()).toMatchObject({revision:1,state:"connecting"});
  a.setLive({connectionError:"socket_connection_rejected",nextReconnectAt:"next"});
  expect(await a.api.status()).toMatchObject({state:"offline",error:"socket_connection_rejected",nextRetryAt:"next"});
  a.setLive({registered:true,connectionError:undefined});
  expect(await a.api.status()).toMatchObject({state:"connected",error:null});
  expect(await a.api.pause({expectedRevision:1})).toMatchObject({revision:2,state:"paused"});
  await a.service.stop();
  const b = managed(config);
  await b.service.recover();await b.service.startLegacy({...legacy,runtimeId:"prod"});
  expect(b.transport.start).not.toHaveBeenCalled();
  expect(await b.api.resume({expectedRevision:2})).toMatchObject({revision:3,state:"connecting"});
  await expect(b.api.forget({expectedRevision:2})).rejects.toThrow("socket_connection_revision_conflict");
  await b.service.stop();
  const c=managed(config);
  await c.service.recover();expect(c.transport.start).toHaveBeenCalledTimes(1);
  expect(await c.api.forget({expectedRevision:3})).toMatchObject({revision:4,state:"not_configured",source:null,serverOrigin:null});
  await c.service.stop();
  const d=managed(config);await d.service.recover();await d.service.startLegacy({...legacy,runtimeId:"prod"});
  expect(d.transport.start).not.toHaveBeenCalled();
  const dir=join(config.paths.sharedDir,"socket-connections");
  const files=await readdir(dir);
  expect(files).toHaveLength(1);
  expect(await readFile(join(dir,files[0]!),"utf8")).not.toContain(bundle.runtimeToken);
  if(process.platform!=="win32")expect((await lstat(join(dir,files[0]!))).mode & 0o077).toBe(0);
});
it("prevents the same relay identity being claimed by a live legacy peer and an aliased import", async()=>{
  const f=await fixture(), prod=managed(f.load("prod")), dev=managed(f.load("dev"));
  const input={bundle:{...bundle,runtimeId:"dev"},expectedRevision:0,confirmBinding:true};
  await dev.service.startLegacy(legacy);
  await expect(prod.api.import(input)).rejects.toThrow("socket_connection_binding_in_use");
  expect(await prod.api.status()).toMatchObject({revision:0,state:"not_configured"});
  expect(dev.transport.stop).not.toHaveBeenCalled();
  await dev.service.stop();
  await prod.api.import(input);
  await prod.api.pause({expectedRevision:1});
  const next=managed(f.load("dev"));
  await expect(next.service.startLegacy(legacy)).rejects.toThrow("socket_connection_binding_in_use");
  await prod.api.forget({expectedRevision:2});
  await next.service.startLegacy(legacy);expect(next.transport.start).toHaveBeenCalledTimes(1);
});
it("serializes competing imports, including distinct owners, before advancing either revision",async()=>{
  const f=await fixture(), a=managed(f.load("prod")), b=managed(f.load("dev"));
  const input={bundle,expectedRevision:0,confirmBinding:true};
  const results=await Promise.allSettled([a.api.import(input),b.api.import(input)]);
  expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);
  expect(results.find(r=>r.status==="rejected")).toMatchObject({reason:new Error("socket_connection_binding_in_use")});
  const revisions=await Promise.all([a.api.status(),b.api.status()]);
  expect(revisions.map(r=>r.revision).sort()).toEqual([0,1]);
  const winner=revisions[0]?.revision===1?a:b;
  const mutations=await Promise.allSettled([winner.api.pause({expectedRevision:1}),winner.api.forget({expectedRevision:1})]);
  expect(mutations.filter(r=>r.status==="fulfilled")).toHaveLength(1);
  expect(mutations.find(r=>r.status==="rejected")).toMatchObject({reason:new Error("socket_connection_revision_conflict")});
});
it("rejects damaged managed identity at load without falling back or presenting stored credentials",async()=>{
  const f=await fixture(), config=f.load("prod"), a=managed(config);
  await a.api.import({bundle,confirmBinding:true,expectedRevision:0});await a.service.stop();
  const dir=join(config.paths.sharedDir,"socket-connections"), [name]=await readdir(dir);
  const p=join(dir,name!), record=JSON.parse(await readFile(p,"utf8"));
  record.connection.runtimeId="../other";await writeFile(p,JSON.stringify(record));
  const next=managed(config);
  await expect(next.service.recover()).rejects.toThrow("socket_connection_store_unavailable");
  await expect(next.service.startLegacy({...legacy,runtimeId:"prod"})).rejects.toThrow("socket_connection_store_unavailable");
  expect(next.transport.start).not.toHaveBeenCalled();
});
it("CLI edits stopped environments without launching an owner, then attaches to an existing owner",async()=>{
  const f=await fixture(), config=f.load("prod"), run=<T>(fn:Parameters<typeof withSocketConnectionManagement<T>>[1])=>withSocketConnectionManagement(config,fn);
  expect(await run(api=>api.status())).toMatchObject({state:"not_configured"});
  expect(await run(api=>api.import({bundle,confirmBinding:true,expectedRevision:0}))).toMatchObject({state:"offline",revision:1});
  expect(await run(api=>api.pause({expectedRevision:1}))).toMatchObject({state:"paused"});
  await expect(lstat(join(config.paths.runtimeDir,"local-host","endpoint.json"))).rejects.toMatchObject({code:"ENOENT"});
  const app=createLocalRuntimeApplication(config); cleanups.push(()=>app.stop()); await app.start();
  expect(await run(api=>api.forget({expectedRevision:2}))).toMatchObject({state:"not_configured",revision:3});
  expect(await app.socketConnection.status()).toMatchObject({state:"not_configured",revision:3});
});
