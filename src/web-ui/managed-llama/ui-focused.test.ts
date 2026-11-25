import { expect, test, vi } from "vitest";
import { createManagedLlamaBinding, renderManagedLlama } from "../app/components/runtime-setup/managed-llama.js";
const status = (extra = {}) => ({ supported: true, closed: false, phase: "idle", installation: "installed", ownsProcess: false, ...extra });
const response = (extra = {}) => ({ ok: true, status: status(extra), capabilities: { release: { size: 123 } } });
const ready = () => response({ phase: "ready", ownsProcess: true });
function deferred() { let resolve!: (x: any) => void; let reject!: (x: any) => void; const promise = new Promise<any>((a,b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function setup() {
  let env = "one";
  const client = { getManagedLlamaStatus: vi.fn(async () => response()), managedLlamaAction: vi.fn(async (_action: string) => response()) };
  const onReady = vi.fn();
  const onChange = vi.fn();
  const binding = createManagedLlamaBinding({ client, getEnvironmentId: () => env, onReady, onChange });
  return { ...binding, binding, client, onReady, onChange, environment: (x: string) => { env = x; } };
}
async function prepared() {
  const s = setup();
  await s.binding.input("mode", "managed");
  s.binding.input("modelPath", "/synthetic/model.gguf");
  s.binding.input("alias", "unit");
  return s;
}
test("construction and manual render are inert; selecting managed only GETs", async () => {
  const s = setup();
  expect(s.binding.state.mode).toBe("manual");
  expect(renderManagedLlama(s.binding.state)).toContain("Existing server");
  expect(s.client.getManagedLlamaStatus).not.toHaveBeenCalled();
  expect(await s.binding.action("install")).toBe(false);
  await s.binding.input("mode", "managed");
  expect(s.client.getManagedLlamaStatus).toHaveBeenCalledExactlyOnceWith("one");
  expect(s.client.managedLlamaAction).not.toHaveBeenCalled();
});
test("start sends exactly five numeric launch fields; Use alone hands off same-start settings", async () => {
  const s = await prepared();
  s.client.managedLlamaAction.mockResolvedValueOnce(ready());
  expect(await s.binding.action("start")).toBe(true);
  expect(s.client.managedLlamaAction).toHaveBeenCalledExactlyOnceWith("start", { modelPath: "/synthetic/model.gguf", alias: "unit", port: 8080, contextTokens: 4096, gpuLayers: 0 }, "one");
  expect(s.onReady).not.toHaveBeenCalled();
  await s.binding.action("use");
  expect(s.onReady).toHaveBeenCalledExactlyOnceWith({ managedLlama: true, model: "unit", baseUrl: "http://127.0.0.1:8080", contextWindowTokens: 4096 });
});
test.each([["port", "80"], ["port", ""], ["port", "8e3"], ["contextTokens", "511"], ["gpuLayers", "-1"], ["alias", "bad alias"], ["modelPath", "relative.gguf"], ["modelPath", "/model.txt"]])("rejects invalid %s=%s locally", async (field, value) => {
  const s = await prepared(); s.binding.input(field, value);
  expect(await s.binding.action("start")).toBe(false);
  expect(s.binding.state.error).not.toBe("");
  expect(s.client.managedLlamaAction).not.toHaveBeenCalled();
});
test.each([{ supported: false }, { installation: "missing" }, { phase: "starting" }, { closed: true }, { ownsProcess: true }])("gates start %j", async extra => {
  const s = await prepared(); s.client.getManagedLlamaStatus.mockResolvedValueOnce(response(extra));
  await s.binding.action("refresh"); expect(await s.binding.action("start")).toBe(false);
  expect(s.client.managedLlamaAction).not.toHaveBeenCalled();
});
test("inspect/install/start/stop are distinct explicit requests", async () => {
  const s = await prepared();
  s.client.getManagedLlamaStatus.mockResolvedValueOnce(response({ installation: "unknown" }));
  await s.binding.action("refresh");
  s.client.managedLlamaAction.mockResolvedValueOnce(response({ installation: "missing" }));
  await s.binding.action("inspect"); await s.binding.action("install");
  s.client.managedLlamaAction.mockResolvedValueOnce(ready());
  await s.binding.action("start"); await s.binding.action("stop");
  expect(s.client.managedLlamaAction.mock.calls.map(x => x[0])).toEqual(["inspect", "install", "start", "stop"]);
  expect(s.binding.state.ready).toBeNull();
});
test.each(["start", "install"])("duplicate %s is rejected and cancel fences success", async name => {
  const s = await prepared();
  if (name === "install") { s.client.getManagedLlamaStatus.mockResolvedValueOnce(response({ installation: "missing" })); await s.binding.action("refresh"); }
  const work = deferred(); const stop = deferred();
  s.client.managedLlamaAction.mockReturnValueOnce(work.promise).mockReturnValueOnce(stop.promise);
  const pending = s.binding.action(name);
  expect(s.binding.isBusy()).toBe(true);
  expect(await s.binding.action(name)).toBe(false);
  const cancellation = s.binding.action("cancel");
  expect(await s.binding.action("cancel")).toBe(false);
  work.resolve(ready()); await pending;
  expect(s.binding.state.ready).toBeNull(); expect(s.binding.state.busy).toBe("cancel");
  stop.resolve(response()); await cancellation;
  expect(s.binding.isBusy()).toBe(false); expect(s.onReady).not.toHaveBeenCalled();
});
test.each(["reset", "environment", "mode"])("ignores stale start after %s without auto-stop", async kind => {
  const s = await prepared(); const work = deferred();
  s.client.managedLlamaAction.mockReturnValueOnce(work.promise);
  const pending = s.binding.action("start");
  if (kind === "reset") s.binding.reset();
  if (kind === "environment") s.environment("two");
  if (kind === "mode") await s.binding.input("mode", "manual");
  work.resolve(ready()); expect(await pending).toBe(false);
  expect(s.binding.state.ready).toBeNull(); expect(s.binding.state.mode).toBe("manual");
  expect(s.client.managedLlamaAction).toHaveBeenCalledTimes(1);
  expect(s.onReady).not.toHaveBeenCalled();
});
test("old status cannot overwrite a newer mode request", async () => {
  const s = setup(); const old = deferred();
  s.client.getManagedLlamaStatus.mockReturnValueOnce(old.promise);
  const pending = s.binding.input("mode", "managed");
  await s.binding.input("mode", "manual"); await s.binding.input("mode", "managed");
  old.resolve(ready()); await pending;
  expect(s.binding.state.status?.phase).toBe("idle");
});
test("failure is retryable, hides dependency messages, retains fields", async () => {
  const s = await prepared();
  s.client.managedLlamaAction.mockRejectedValueOnce(new Error("private details"));
  expect(await s.binding.action("start")).toBe(false);
  expect(s.binding.state.error).not.toContain("private details");
  expect(s.binding.state.retry).toBe("start");
  expect(s.binding.state.modelPath).toBe("/synthetic/model.gguf");
  s.client.managedLlamaAction.mockResolvedValueOnce(ready());
  expect(await s.binding.action("retry")).toBe(true);
});
test("status readiness never supplies launch settings, and refresh invalidates prior readiness", async () => {
  const s = await prepared(); s.client.managedLlamaAction.mockResolvedValueOnce(ready());
  await s.binding.action("start");
  s.client.getManagedLlamaStatus.mockResolvedValueOnce(ready()); await s.binding.action("refresh");
  expect(await s.binding.action("use")).toBe(false); expect(s.onReady).not.toHaveBeenCalled();
  expect(renderManagedLlama(s.binding.state)).toContain("does not know its launch settings");
});
test("cancel failure cannot resurrect successful start; explicit stop remains possible after refresh", async () => {
  const s = await prepared(); const work = deferred();
  s.client.managedLlamaAction.mockReturnValueOnce(work.promise).mockRejectedValueOnce(new Error("failed"));
  const pending = s.binding.action("start"); await s.binding.action("cancel");
  work.resolve(ready()); await pending;
  expect(s.binding.state.ready).toBeNull(); expect(await s.binding.action("use")).toBe(false);
  s.client.getManagedLlamaStatus.mockResolvedValueOnce(ready()); await s.binding.action("refresh");
  expect(await s.binding.action("stop")).toBe(true);
});
test("render escapes entered values, metadata, errors and prefix; includes notices and distinct controls", async () => {
  const s = await prepared(); s.binding.input("alias", '\"<script>&');
  s.binding.state.error = '<script>bad</script>';
  s.binding.state.capabilities = { release: { size: 123, tag: '<script>' } };
  const html = renderManagedLlama(s.binding.state, '\"<script>');
  expect(html).not.toContain('<script>'); expect(html).toContain('&lt;script&gt;');
  expect(html).not.toContain('type="password"');
  for (const action of ['inspect', 'install', 'start', 'stop', 'cancel', 'refresh', 'use']) expect(html).toContain('data-managed-llama-action="' + action + '"');
  expect(html).toContain('Windows 10/11'); expect(html).toContain('unverified'); expect(html).toContain('123');
  expect(html).toContain('no model download'); expect(html).toContain('data-managed-llama-action="use" disabled');
  expect(s.binding.state.alias).toBe('\"<script>&');
});
