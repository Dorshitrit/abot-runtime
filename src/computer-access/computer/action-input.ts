import { SystemOperationError } from "../contracts.js";
import type {
  NativeComputerAction,
  PhysicalPoint,
  PhysicalRectangle,
} from "./native-protocol.js";

export function computerInputError(message: string): never {
  throw new SystemOperationError("computer_input_invalid", message);
}
export function computerRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return computerInputError("An object is required.");
  return value as Record<string, unknown>;
}
export function computerFields(
  value: Record<string, unknown>,
  fields: readonly string[],
): void {
  if (Object.keys(value).some((key) => !fields.includes(key)))
    computerInputError("Unexpected computer operation fields.");
}
export function computerText(value: unknown, maximum = 4096): string {
  if (typeof value !== "string")
    return computerInputError("A string is required.");
  if (value.length > maximum)
    return computerInputError("Computer text exceeds its limit.");
  return value;
}
export function computerNumber(
  value: unknown,
  minimum: number,
  maximum: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    return computerInputError("A finite number is required.");
  if (value < minimum || value > maximum)
    return computerInputError(
      "Computer coordinate or duration is out of range.",
    );
  return value;
}
export function readPhysicalRectangle(value: unknown): PhysicalRectangle {
  const rect = computerRecord(value);
  computerFields(rect, ["x", "y", "width", "height"]);
  return {
    x: computerNumber(rect.x, -131072, 131072),
    y: computerNumber(rect.y, -131072, 131072),
    width: computerNumber(rect.width, 1, 65536),
    height: computerNumber(rect.height, 1, 65536),
  };
}
function readPoint(value: unknown): PhysicalPoint {
  const point = computerRecord(value);
  computerFields(point, ["x", "y"]);
  return {
    x: computerNumber(point.x, -131072, 131072),
    y: computerNumber(point.y, -131072, 131072),
  };
}
function readButton(value: unknown): "left" | "middle" | "right" {
  if (value === "left" || value === "middle" || value === "right") return value;
  return computerInputError("Select left, middle or right button.");
}
export function readNativeComputerAction(value: unknown): NativeComputerAction {
  const action = computerRecord(value);
  switch (action.kind) {
    case "click": {
      computerFields(action, ["kind", "point", "button", "count"]);
      if (action.count !== 1 && action.count !== 2)
        return computerInputError("Click count must be one or two.");
      return {
        kind: action.kind,
        point: readPoint(action.point),
        button: readButton(action.button),
        count: action.count,
      };
    }
    case "move":
      computerFields(action, ["kind", "point"]);
      return { kind: action.kind, point: readPoint(action.point) };
    case "drag":
      computerFields(action, ["kind", "from", "to", "button", "durationMs"]);
      return {
        kind: action.kind,
        from: readPoint(action.from),
        to: readPoint(action.to),
        button: readButton(action.button),
        durationMs: computerNumber(action.durationMs, 0, 5000),
      };
    case "scroll":
      computerFields(action, ["kind", "deltaX", "deltaY"]);
      return {
        kind: action.kind,
        deltaX: computerNumber(action.deltaX, -5000, 5000),
        deltaY: computerNumber(action.deltaY, -5000, 5000),
      };
    case "type_text":
      computerFields(action, ["kind", "text"]);
      return { kind: action.kind, text: computerText(action.text, 4096) };
    case "press_keys": {
      computerFields(action, ["kind", "keys"]);
      if (!Array.isArray(action.keys))
        return computerInputError("Keys must be an array.");
      if (action.keys.length < 1 || action.keys.length > 8)
        return computerInputError("Use one to eight explicit keys.");
      return {
        kind: action.kind,
        keys: action.keys.map((key) => computerText(key, 32)),
      };
    }
    case "focus_window":
      computerFields(action, ["kind", "windowBinding"]);
      return {
        kind: action.kind,
        windowBinding: computerText(action.windowBinding),
      };
    default:
      return computerInputError("Unknown computer action.");
  }
}
