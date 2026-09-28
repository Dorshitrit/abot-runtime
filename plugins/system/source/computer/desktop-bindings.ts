import { randomUUID } from "node:crypto";
import { SystemOperationError } from "../../../../src/plugin-sdk/computer-access.js";
import type {
  NativeComputerAction,
  NativeComputerResult,
  NativeComputerObservation,
  PhysicalPoint,
  PhysicalRectangle,
} from "../../../../src/plugin-sdk/computer-access.js";
import {
  computerRecord,
  computerFields,
  computerText,
  readNativeComputerAction,
  readNativeComputerResult,
} from "../../../../src/plugin-sdk/computer-access.js";

/** References are owned by a request and never reconstructed from titles or history. */
export class DesktopBindings {
  private current?: {
    id: string;
    issuedAt: number;
    result: NativeComputerResult;
    observation: NativeComputerObservation;
  };
  private readonly windows = new Map<string, string>();

  observe(result: NativeComputerResult) {
    this.windows.clear();
    const windows = result.windows.map((window) => {
      const id = randomUUID();
      this.windows.set(id, window.binding);
      const { binding: _binding, ...details } = window;
      return {
        window_ref: id,
        ...details,
        bounds: result.observation
          ? imageRectangle(window.bounds, result.observation)
          : window.bounds,
      };
    });
    this.current = undefined;
    if (!result.observation)
      return {
        windows,
        observation_ref: undefined,
        coordinateSpace: result.desktop.coordinateSpace ?? "native_desktop",
      };
    const id = randomUUID();
    this.current = {
      id,
      issuedAt: Date.now(),
      result,
      observation: result.observation,
    };
    const {
      region: _region,
      accessibility,
      ...observation
    } = result.observation;
    return {
      windows,
      observation_ref: id,
      ...observation,
      coordinateSpace: "image_pixels",
      accessibility: accessibility.map((node) => ({
        ...node,
        ...(node.bounds
          ? { bounds: imageRectangle(node.bounds, result.observation!) }
          : {}),
      })),
    };
  }

  action(observationRef: unknown, value: unknown) {
    const current = this.current;
    if (!current || current.id !== observationRef)
      throw new SystemOperationError(
        "computer_observation_stale",
        "Observe this desktop again; the observation reference is not current for this request.",
      );
    if (Date.now() - current.issuedAt > 120_000)
      throw new SystemOperationError(
        "computer_observation_expired",
        "The observation is more than two minutes old. Observe again before input.",
      );
    const action = this.resolveAction(value);
    const translated = translateAction(action, current.observation);
    // Consumed before dispatch: an uncertain result must never replay this observation.
    this.current = undefined;
    return {
      operation: "act" as const,
      desktopBinding: current.result.desktop.binding,
      expectedGeometry: current.result.desktop.bounds,
      ...(current.result.focusedWindow
        ? { expectedWindow: current.result.focusedWindow }
        : {}),
      action: translated,
      deadlineEpochMs: Date.now() + 15_000,
    };
  }

  snapshot() {
    const current = this.current;
    const result = current
      ? (({ image: _image, ...value }) => value)(current.result)
      : undefined;
    return {
      kind: "desktop_bindings_v1",
      windows: [...this.windows],
      ...(current
        ? { current: { id: current.id, issuedAt: current.issuedAt, result } }
        : {}),
    };
  }

  restore(value: unknown): void {
    const saved = computerRecord(value);
    computerFields(saved, ["kind", "windows", "current"]);
    if (
      saved.kind !== "desktop_bindings_v1" ||
      !Array.isArray(saved.windows) ||
      saved.windows.length > 256
    )
      throw new Error("desktop_bindings_snapshot_invalid");
    const windows = new Map<string, string>();
    for (const item of saved.windows) {
      if (!Array.isArray(item) || item.length !== 2)
        throw new Error("desktop_bindings_snapshot_invalid");
      const ref = computerText(item[0], 128),
        binding = computerText(item[1]);
      if (windows.has(ref))
        throw new Error("desktop_bindings_snapshot_invalid");
      windows.set(ref, binding);
    }
    let current: typeof this.current;
    if (saved.current !== undefined) {
      const entry = computerRecord(saved.current);
      computerFields(entry, ["id", "issuedAt", "result"]);
      const id = computerText(entry.id, 128);
      if (
        typeof entry.issuedAt !== "number" ||
        !Number.isFinite(entry.issuedAt) ||
        entry.issuedAt < 0
      )
        throw new Error("desktop_bindings_snapshot_invalid");
      const result = readNativeComputerResult(entry.result);
      if (!result.observation)
        throw new Error("desktop_bindings_snapshot_invalid");
      current = {
        id,
        issuedAt: entry.issuedAt,
        result,
        observation: result.observation,
      };
    }
    this.clear();
    this.current = current;
    for (const [ref, binding] of windows) this.windows.set(ref, binding);
  }

  clear(): void {
    this.current = undefined;
    this.windows.clear();
  }

  regionalObservation(observationRef: unknown, rectangle: PhysicalRectangle) {
    const current = this.current;
    if (!current || current.id !== observationRef)
      throw new SystemOperationError(
        "computer_observation_stale",
        "Use a current observation to select a smaller region.",
      );
    const observation = current.observation;
    if (!isRegionInsideImage(rectangle, observation))
      throw new SystemOperationError(
        "computer_region_outside_image",
        "Select a region inside the returned image.",
      );
    const scaleX = observation.region.width / observation.imageWidth;
    const scaleY = observation.region.height / observation.imageHeight;
    return {
      operation: "observe" as const,
      desktopBinding: current.result.desktop.binding,
      expectedGeometry: current.result.desktop.bounds,
      region: {
        x: Math.round(observation.region.x + rectangle.x * scaleX),
        y: Math.round(observation.region.y + rectangle.y * scaleY),
        width: Math.max(1, Math.floor(rectangle.width * scaleX)),
        height: Math.max(1, Math.floor(rectangle.height * scaleY)),
      },
    };
  }

  private resolveAction(value: unknown): NativeComputerAction {
    const action = computerRecord(value);
    if (action.kind !== "focus_window") return readNativeComputerAction(action);
    const ref = computerText(action.window_ref, 128);
    if (
      Object.keys(action).some((key) => !["kind", "window_ref"].includes(key))
    )
      throw new SystemOperationError(
        "computer_input_invalid",
        "Unexpected focus fields.",
      );
    const binding = this.windows.get(ref);
    if (!binding)
      throw new SystemOperationError(
        "computer_window_stale",
        "Select a window returned by this observation.",
      );
    return { kind: "focus_window", windowBinding: binding };
  }
}

function imageRectangle(
  bounds: PhysicalRectangle,
  observation: NativeComputerObservation,
): PhysicalRectangle {
  const scaleX = observation.imageWidth / observation.region.width;
  const scaleY = observation.imageHeight / observation.region.height;
  return {
    x: (bounds.x - observation.region.x) * scaleX,
    y: (bounds.y - observation.region.y) * scaleY,
    width: bounds.width * scaleX,
    height: bounds.height * scaleY,
  };
}

function isRegionInsideImage(
  rectangle: PhysicalRectangle,
  observation: NativeComputerObservation,
): boolean {
  if (rectangle.x < 0 || rectangle.y < 0) return false;
  if (rectangle.x + rectangle.width > observation.imageWidth) return false;
  return rectangle.y + rectangle.height <= observation.imageHeight;
}

function translateAction(
  action: NativeComputerAction,
  observation: NativeComputerObservation,
): NativeComputerAction {
  const point = (value: PhysicalPoint): PhysicalPoint => {
    if (
      value.x < 0 ||
      value.x >= observation.imageWidth ||
      value.y < 0 ||
      value.y >= observation.imageHeight
    )
      throw new SystemOperationError(
        "computer_coordinate_outside_image",
        "Use coordinates inside the returned image.",
      );
    return {
      x: Math.round(
        observation.region.x +
          (value.x * observation.region.width) / observation.imageWidth,
      ),
      y: Math.round(
        observation.region.y +
          (value.y * observation.region.height) / observation.imageHeight,
      ),
    };
  };
  if (action.kind === "click" || action.kind === "move")
    return { ...action, point: point(action.point) };
  if (action.kind === "drag")
    return { ...action, from: point(action.from), to: point(action.to) };
  return action;
}
