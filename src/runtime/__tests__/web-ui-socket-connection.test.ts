import { afterEach, describe, expect, test, vi } from "vitest";
import { createRuntimeWebClient } from "../../web-ui/app/services/runtime-web-client.js";
// @ts-expect-error Browser module is exercised through its DOM and HTTP contracts.
import { createSocketConnectionFeature } from "../../web-ui/app/components/socket-connection/feature.js";
import { createHomeWidgetsHarness } from "./support/home-widgets-harness.js";

const unpaired = { revision: 4, localEnvironmentId: "local", state: "not_configured",
  source: null, remoteRuntimeId: null, serverOrigin: null, lastRegisteredAt: null, nextRetryAt: null, error: null };
const alias = { localEnvironmentId: "local", remoteRuntimeId: "studio", serverOrigin: "wss://socket.test", bindingConfirmationRequired: true };
const registered = { ...unpaired, ...alias, revision: 5, state: "connected", source: "managed" };
const bundle = { runtimeId: "studio", agentBridgeUrl: "wss://socket.test/agent", runtimeToken: "synthetic-runtime-only" };
const setup = JSON.stringify({ runtimeConnection: bundle, adminToken: "synthetic-unrelated" });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function settle() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
function fixture(initial: Record<string, unknown> = unpaired) {
  const h = createHomeWidgetsHarness();
  let environment = "local";
  let supported = true;
  const get = vi.fn(async (_env: string): Promise<{connection: Record<string, unknown>}> => ({ connection: initial }));
  const preview = vi.fn(async () => ({ preview: alias }));
  const change = vi.fn(async () => ({ connection: registered }));
  const panel = h.createElement("section");
  panel.innerHTML = '<h2 data-socket-label></h2><p data-socket-detail></p><button type="button">Manage</button>';
  h.root.append(panel);
  const page = new EventTarget();
  const feature = createSocketConnectionFeature({ panel, client: {
    getSocketConnection: get, previewSocketConnection: preview, changeSocketConnection: change },
    getEnvironmentId: () => environment, supported: () => supported, ready: () => true,
    documentRoot: h.documentRoot, page, intervalMs: 1000 });
  const dialog = () => h.documentRoot.body.querySelector("dialog")!;
  const field = (key: string) => dialog().querySelector('[data-sc="' + key + '"]')!;
  return { ...h, get, preview, change, panel, feature, page, dialog, field,
    submit: () => dialog().querySelector("form")!.dispatch("submit"),
    enter: async () => { feature.setActive(true); await settle(); panel.querySelector("button")!.dispatch("click"); await settle(); },
    scope: (id: string) => { environment = id; feature.sync(); },
    support: (value: boolean) => { supported = value; feature.sync(); },
  };
}

afterEach(() => vi.useRealTimers());
describe("Home Socket connection", () => {
  test("reviews a private setup file and its explicit local binding before the first write", async () => {
    const f = fixture();
    await f.enter();
    expect(f.field("import").hidden).toBe(false);
    Object.assign(f.field("file"), { files: [{ size: setup.length, text: async () => setup }] });
    f.submit();
    await settle();
    expect(f.preview).toHaveBeenCalledExactlyOnceWith(bundle, "local");
    expect(f.change).not.toHaveBeenCalled();
    expect(f.field("local").textContent).toBe("local");
    expect(f.field("remote").textContent).toBe("studio");
    expect(f.field("origin").textContent).toBe("wss://socket.test");
    expect(f.field("intro").textContent).toContain("IDs differ");
    expect(f.dialog().textContent).not.toContain("synthetic");
    f.submit();
    f.submit();
    await settle();
    expect(f.change).toHaveBeenCalledExactlyOnceWith("connect", { bundle, expectedRevision: 4, confirmBinding: true }, "local");
    expect(f.dialog().open).toBe(false);
    expect(f.panel.dataset.socketState).toBe("connected");
    f.feature.setActive(false);
  });

  test("reviews manual fields through the same Runtime preview before saving the confirmed binding", async () => {
    const f = fixture();
    await f.enter();
    f.field("input-mode").dispatch("click");
    expect(f.field("manual-fields").hidden).toBe(false);
    expect(f.field("json-fields").hidden).toBe(true);
    expect(f.field("runtime-token").getAttribute("type")).toBe("password");
    expect(f.field("runtime-token").getAttribute("autocomplete")).toBe("off");
    f.field("server-url").value = "  " + bundle.agentBridgeUrl + "  ";
    f.field("runtime-id").value = " " + bundle.runtimeId + " ";
    f.field("runtime-token").value = bundle.runtimeToken;
    f.submit();
    await settle();
    expect(f.preview).toHaveBeenCalledExactlyOnceWith(bundle, "local");
    expect(f.change).not.toHaveBeenCalled();
    expect(f.field("identity").hidden).toBe(false);
    for (const key of ["server-url", "runtime-id", "runtime-token"]) expect(f.field(key).value).toBe("");
    f.submit();
    f.submit();
    await settle();
    expect(f.change).toHaveBeenCalledExactlyOnceWith("connect", { bundle, expectedRevision: 4, confirmBinding: true }, "local");
    expect(f.dialog().textContent).not.toContain(bundle.runtimeToken);
    f.feature.setActive(false);
  });

  test("switching input methods discards credentials from the abandoned method", async () => {
    const f = fixture();
    await f.enter();
    f.field("paste").value = setup;
    f.field("input-mode").dispatch("click");
    expect(f.field("paste").value).toBe("");
    f.field("server-url").value = bundle.agentBridgeUrl;
    f.field("runtime-id").value = bundle.runtimeId;
    f.field("runtime-token").value = bundle.runtimeToken;
    f.field("input-mode").dispatch("click");
    expect(f.field("manual-fields").hidden).toBe(true);
    expect(f.field("json-fields").hidden).toBe(false);
    for (const key of ["server-url", "runtime-id", "runtime-token"]) expect(f.field(key).value).toBe("");
    expect(f.preview).not.toHaveBeenCalled();
    expect(f.change).not.toHaveBeenCalled();
    f.feature.setActive(false);
  });

  test.each(["environment", "pagehide", "cancel"])("discards a manual preview after %s and never saves stale credentials", async action => {
    const f = fixture();
    await f.enter();
    f.field("input-mode").dispatch("click");
    f.field("server-url").value = bundle.agentBridgeUrl;
    f.field("runtime-id").value = bundle.runtimeId;
    f.field("runtime-token").value = bundle.runtimeToken;
    const pending = deferred<{preview: typeof alias}>();
    f.preview.mockImplementationOnce(() => pending.promise);
    f.submit();
    await settle();
    if (action === "environment") f.scope("other");
    if (action === "pagehide") f.page.dispatchEvent(new Event("pagehide"));
    if (action === "cancel") f.field("cancel").dispatch("click");
    pending.resolve({ preview: alias });
    await settle();
    expect(f.dialog().open).toBe(false);
    expect(f.change).not.toHaveBeenCalled();
    for (const key of ["server-url", "runtime-id", "runtime-token"]) expect(f.field(key).value).toBe("");
    f.feature.setActive(false);
  });

  test("leaves manual credential validation to Runtime and prevents a rejected preview from saving", async () => {
    const f = fixture();
    await f.enter();
    f.field("input-mode").dispatch("click");
    f.field("server-url").value = "https://wrong-endpoint.test";
    f.field("runtime-id").value = "";
    f.field("runtime-token").value = "synthetic-invalid-token";
    f.preview.mockRejectedValueOnce({ status: 409, code: "socket_connection_bundle_invalid", message: "synthetic-invalid-token" });
    f.submit();
    await settle();
    expect(f.preview).toHaveBeenCalledExactlyOnceWith({ runtimeId: "", agentBridgeUrl: "https://wrong-endpoint.test", runtimeToken: "synthetic-invalid-token" }, "local");
    expect(f.change).not.toHaveBeenCalled();
    expect(f.field("primary").hidden).toBe(true);
    expect(f.field("reload").hidden).toBe(false);
    expect(f.field("runtime-token").value).toBe("");
    expect(f.dialog().textContent).not.toContain("synthetic-invalid-token");
    f.feature.setActive(false);
  });

  test("Skip and Cancel clear pasted input without importing; an old preview cannot reopen or change a new environment", async () => {
    const f = fixture();
    const offered = f.feature.offerSetup("local");
    await settle();
    f.field("paste").value = setup;
    f.field("skip").dispatch("click");
    expect(await offered).toBe(true);
    expect(f.field("paste").value).toBe("");
    expect(f.change).not.toHaveBeenCalled();
    await f.enter();
    f.field("paste").value = setup;
    f.field("cancel").dispatch("click");
    expect(f.field("paste").value).toBe("");
    await f.enter();
    const pending = deferred<{preview: typeof alias}>();
    f.preview.mockImplementationOnce(() => pending.promise);
    f.field("paste").value = setup;
    f.submit();
    await settle();
    expect(f.field("paste").value).toBe("");
    f.scope("other");
    pending.resolve({ preview: alias });
    await settle();
    expect(f.dialog().open).toBe(false);
    expect(f.change).not.toHaveBeenCalled();
    f.feature.setActive(false);
  });

  test.each([["connected", "pause"], ["paused", "resume"]])("manages legacy %s with the revision shown", async (state, action) => {
    const f = fixture({ ...registered, source: "legacy", state });
    await f.enter();
    f.field("manage").dispatch("click");
    await settle();
    expect(f.change).toHaveBeenCalledExactlyOnceWith(action, { expectedRevision: 5 }, "local");
    f.feature.setActive(false);
  });

  test("requires an additional explicit confirmation for local Forget and leaves failed writes recoverable", async () => {
    const f = fixture(registered);
    await f.enter();
    f.field("forget").dispatch("click");
    expect(f.field("intro").textContent).toContain("from this computer");
    f.field("cancel").dispatch("click");
    expect(f.change).not.toHaveBeenCalled();
    await f.enter();
    f.field("forget").dispatch("click");
    f.change.mockRejectedValueOnce({ status: 409, message: "synthetic-secret" });
    f.submit();
    await settle();
    expect(f.change).toHaveBeenCalledExactlyOnceWith("forget", { expectedRevision: 5 }, "local");
    expect(f.field("notice").textContent).toContain("Reload");
    expect(f.dialog().textContent).not.toContain("synthetic-secret");
    f.field("reload").dispatch("click");
    await settle();
    expect(f.field("manage").hidden).toBe(false);
    f.feature.setActive(false);
  });

  test.each([
    ["socket_connection_busy", "A Socket request is in progress"],
    ["socket_connection_store_unavailable", "Check file access on the Runtime computer"],
  ])("explains %s without exposing server text", async (code, expected) => {
    const f = fixture(registered);
    await f.enter();
    f.change.mockRejectedValueOnce({ status: 409, code, message: "synthetic-secret" });
    f.field("manage").dispatch("click");
    await settle();
    expect(f.field("notice").textContent).toContain(expected);
    expect(f.dialog().textContent).not.toContain("synthetic-secret");
    f.feature.setActive(false);
  });

  test("only polls a visible supported environment and drops reads racing a page or environment change", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.support(false);
    await f.enter();
    expect(f.get).not.toHaveBeenCalled();
    expect(await f.feature.offerSetup("local")).toBe(false);
    const pending = deferred<{connection: Record<string, unknown>}>();
    f.get.mockImplementationOnce(() => pending.promise);
    f.support(true);
    f.get.mockResolvedValue({ connection: { ...registered, localEnvironmentId: "new" } });
    f.scope("new");
    await settle();
    pending.resolve({ connection: unpaired });
    await settle();
    expect(f.panel.dataset.socketState).toBe("connected");
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.get).toHaveBeenCalledTimes(3);
    f.page.dispatchEvent(new Event("pagehide"));
    expect(f.panel.hidden).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.get).toHaveBeenCalledTimes(3);
    f.page.dispatchEvent(new Event("pageshow"));
    await settle();
    expect(f.get).toHaveBeenCalledTimes(4);
    f.feature.setActive(false);
  });

  test("scopes management requests and carries credentials only in the review/import bodies", async () => {
    const fetchImpl = vi.fn(async (_address: RequestInfo | URL, _init?: RequestInit) => new Response("{}"));
    const client = createRuntimeWebClient({ getConfig: () => ({ backend: "runtime" }), getEnvironmentId: () => "wrong",
      origin: "http://localhost", fetchImpl });
    await client.getSocketConnection("chosen");
    await client.previewSocketConnection(bundle, "chosen");
    await client.changeSocketConnection("connect", { expectedRevision: 4, confirmBinding: true, bundle }, "chosen");
    await client.changeSocketConnection("pause", { expectedRevision: 5 }, "chosen");
    expect(fetchImpl.mock.calls.map(([path]) => path)).toEqual(["", "/preview", "/connect", "/pause"].map(action =>
      "/web-api/socket-connection" + action + "?environment=chosen"));
    expect(fetchImpl.mock.calls.map(([,init]) => init?.body ? JSON.parse(String(init.body)) : null)).toEqual([
      null, { bundle }, { expectedRevision: 4, confirmBinding: true, bundle }, { expectedRevision: 5 },
    ]);
  });
});
