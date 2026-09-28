import { describe, expect, it, vi } from "vitest";
import { DesktopBindings } from "../../../plugins/system/source/computer/desktop-bindings.js";
import {
  RequestComputers,
  computerQueueIdentity,
} from "../../../plugins/system/source/computer/request-computers.js";
import { createComputerHandlers } from "../../../plugins/system/source/computer/handlers.js";
import { withDesktopQueue } from "../../computer-access/computer/desktop-action-queue.js";
import { captureSystemTargetSnapshot } from "../../../plugins/system/source/request-target-snapshot.js";
import {
  backendFixture,
  computerRoute,
  desktopFixture,
} from "./computer-plugin-fixtures.js";
import type { ToolExecutionContext } from "../../capabilities/tool-types.js";

describe("computer observation and action ownership", () => {
  it("uses only the current request observation and translates scaled negative-origin coordinates", () => {
    const bindings = new DesktopBindings();
    const first = bindings.observe(desktopFixture());
    const next = bindings.observe(desktopFixture());
    expect(() =>
      bindings.action(first.observation_ref, {
        kind: "move",
        point: { x: 10, y: 20 },
      }),
    ).toThrow("observation reference");
    const request = bindings.action(next.observation_ref, {
      kind: "move",
      point: { x: 10, y: 20 },
    });
    expect(request.action).toEqual({
      kind: "move",
      point: { x: -1900, y: 40 },
    });
    expect(request.desktopBinding).toBe("session:10");
    expect(request.expectedWindow).toBe("pid:1/start:2/window:3");
    expect(() =>
      bindings.action(next.observation_ref, {
        kind: "move",
        point: { x: 10, y: 20 },
      }),
    ).toThrow();
  });
  it("rejects image-edge overflow, foreign windows and reference reuse after disposal", () => {
    const bindings = new DesktopBindings();
    const observed = bindings.observe(desktopFixture());
    expect(() =>
      bindings.action(observed.observation_ref, {
        kind: "move",
        point: { x: 1920, y: 0 },
      }),
    ).toThrow("inside the returned image");
    expect(() =>
      bindings.action(observed.observation_ref, {
        kind: "focus_window",
        window_ref: "unobserved",
      }),
    ).toThrow("returned by this observation");
    bindings.clear();
    expect(() =>
      bindings.action(observed.observation_ref, {
        kind: "press_keys",
        keys: ["Enter"],
      }),
    ).toThrow();
  });
  it("passes image bytes through the writer only and registers request cleanup exactly once", async () => {
    const backend = backendFixture();
    const computers = new RequestComputers(
      "/tmp",
      [computerRoute],
      fakeConnection(),
      () => backend,
    );
    const handlers = createComputerHandlers(computers);
    const callbacks: Array<() => void | Promise<void>> = [];
    const writer = vi.fn(async () => ({
      kind: "tool_image_v1" as const,
      id: "image-reference",
      mimeType: "image/png" as const,
      size: 3,
      width: 1920,
      height: 1080,
      sha256: "0".repeat(64),
    }));
    const context: ToolExecutionContext = {
      media: { writeImage: writer },
      onRequestDispose: (callback) => {
        callbacks.push(callback);
      },
    };
    const ref = computers.entries[0]!.ref;
    const result = await handlers.computer_observe!(
      { desktop_ref: ref },
      context,
    );
    expect(result.ok).toBe(true);
    expect(result.media).toHaveLength(1);
    expect(result.output).not.toContain("image-reference");
    expect(JSON.stringify(result.data)).not.toContain("bytes");
    expect(writer).toHaveBeenCalledTimes(1);
    const action = await handlers.computer_act!(
      {
        desktop_ref: ref,
        observation_ref: result.data?.observation_ref,
        action_kind: "press_keys",
        keys: ["Enter"],
      },
      context,
    );
    expect(action.ok).toBe(true);
    expect(callbacks).toHaveLength(1);
    await callbacks[0]!();
    expect(backend.close).toHaveBeenCalledTimes(1);
    expect(() => computers.require(ref)).toThrow("expired");
  });
  it("preserves an accepted input receipt if subsequent image admission fails", async () => {
    const backend = backendFixture();
    vi.mocked(backend.execute).mockResolvedValue({
      ...desktopFixture(),
      dispatch: {
        status: "accepted",
        requestedInputCount: 2,
        acceptedInputCount: 2,
      },
    });
    const computers = new RequestComputers(
      "/tmp",
      [computerRoute],
      fakeConnection(),
      () => backend,
    );
    const result = await createComputerHandlers(computers).computer_observe!(
      { desktop_ref: computers.entries[0]!.ref },
      {
        onRequestDispose: () => undefined,
        media: {
          writeImage: async () => {
            throw new Error("media budget reached");
          },
        },
      },
    );
    expect(result.ok).toBe(false);
    expect(result.data?.dispatch).toMatchObject({ status: "accepted" });
    expect(result.data?.requestedEffectVerified).toBe(false);
    await computers.close();
  });
  it("does not invoke a backend without request cleanup ownership", async () => {
    const backend = backendFixture();
    const computers = new RequestComputers(
      "/tmp",
      [computerRoute],
      fakeConnection(),
      () => backend,
    );
    const result = await createComputerHandlers(computers).computer_desktops!(
      {},
      {},
    );
    expect(result.errorCode).toBe("computer_lifecycle_unavailable");
    expect(backend.execute).not.toHaveBeenCalled();
  });
  it("does not issue actionable references when admitted pixels disagree with the native dimensions", async () => {
    const backend = backendFixture();
    vi.mocked(backend.execute).mockResolvedValue({
      ...desktopFixture(),
      dispatch: {
        status: "accepted",
        requestedInputCount: 1,
        acceptedInputCount: 1,
      },
    });
    const computers = new RequestComputers(
      "/tmp",
      [computerRoute],
      fakeConnection(),
      () => backend,
    );
    const result = await createComputerHandlers(computers).computer_observe!(
      { desktop_ref: computers.entries[0]!.ref },
      {
        onRequestDispose: () => undefined,
        media: {
          writeImage: async () => ({
            kind: "tool_image_v1",
            id: "fixture-image",
            mimeType: "image/png",
            size: 3,
            width: 1,
            height: 1,
            sha256: "0".repeat(64),
          }),
        },
      },
    );
    expect(result.ok).toBe(false);
    expect(result.data?.imageAvailable).toBe(false);
    expect(result.data?.observation_ref).toBeUndefined();
    expect(result.media).toEqual([]);
    expect(result.data?.dispatch).toMatchObject({ status: "accepted" });
    await computers.close();
  });
  it("projects accessibility and window geometry in the image coordinate space and expires old input", () => {
    const bindings = new DesktopBindings();
    const fixture = desktopFixture();
    const observation = bindings.observe({
      ...fixture,
      observation: {
        ...fixture.observation!,
        accessibility: [
          {
            role: "button",
            bounds: { x: -1900, y: 40, width: 100, height: 60 },
          },
        ],
      },
    });
    expect(observation.coordinateSpace).toBe("image_pixels");
    expect(
      "accessibility" in observation && observation.accessibility?.[0]?.bounds,
    ).toEqual({ x: 10, y: 20, width: 50, height: 30 });
    expect(observation.windows[0]?.bounds).toMatchObject({
      x: 0,
      y: 0,
      width: 960,
    });
    expect(
      bindings.regionalObservation(observation.observation_ref, {
        x: 10,
        y: 20,
        width: 50,
        height: 30,
      }).region,
    ).toEqual({ x: -1900, y: 40, width: 100, height: 60 });
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 120_001);
    try {
      expect(() =>
        bindings.action(observation.observation_ref, {
          kind: "press_keys",
          keys: ["Enter"],
        }),
      ).toThrow("two minutes");
    } finally {
      now.mockRestore();
    }
  });
});

describe("computer route and queue isolation", () => {
  it("retains both Linux container and Linux companion while old command projection remains deduplicated", async () => {
    const input = {
      observeTargets: async () =>
        ({
          targets: [
            {
              ...computerRoute.target,
              available: true,
              commandExecutionAvailable: true,
              guiSessionStatus: "not_checked",
            },
          ],
          availabilityScope: "command_execution_only",
          host: {},
        }) as never,
      readHostStatus: async () =>
        ({
          paired: true,
          connected: true,
          hostId: "12345678-1234-4234-8234-123456789012",
          connectionId: "12345678-1234-4234-8234-123456789013",
          identity: {
            name: "Linux host",
            os: "linux",
            user: "user",
            homeDir: "/home/user",
          },
          capabilities: ["computer_control_v1"],
        }) as never,
    };
    expect(await captureSystemTargetSnapshot(input)).toHaveLength(1);
    const routes = await captureSystemTargetSnapshot({
      ...input,
      includeSameOsCompanion: true,
    });
    expect(routes).toHaveLength(2);
    const computers = new RequestComputers("/tmp", routes, fakeConnection());
    expect(new Set(computers.entries.map((entry) => entry.ref)).size).toBe(2);
    let release!: () => void;
    const first = withDesktopQueue(
      computerQueueIdentity(computers.entries[0]!),
      undefined,
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await Promise.resolve();
    const secondAction = vi.fn(async () => undefined);
    const second = withDesktopQueue(
      computerQueueIdentity(computers.entries[1]!),
      undefined,
      secondAction,
    );
    await Promise.resolve();
    expect(secondAction).not.toHaveBeenCalled();
    release();
    await Promise.all([first, second]);
    expect(secondAction).toHaveBeenCalledTimes(1);
    await computers.close();
  });
  it("serializes one destination and lets another progress, skipping cancelled queued injection", async () => {
    let release!: () => void;
    const first = withDesktopQueue(
      "one",
      undefined,
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await Promise.resolve();
    const signal = new AbortController();
    const action = vi.fn(async () => undefined);
    const next = withDesktopQueue("one", signal.signal, action);
    const rejected = expect(next).rejects.toThrow();
    await withDesktopQueue("two", undefined, async () => undefined);
    signal.abort();
    await rejected;
    const thirdAction = vi.fn(async () => undefined);
    const third = withDesktopQueue("one", undefined, thirdAction);
    await Promise.resolve();
    expect(thirdAction).not.toHaveBeenCalled();
    release();
    await first;
    await third;
    expect(thirdAction).toHaveBeenCalledTimes(1);
    expect(action).not.toHaveBeenCalled();
  });
});

function fakeConnection() {
  return { readHostStatus: vi.fn(), executeHostOperation: vi.fn() };
}
