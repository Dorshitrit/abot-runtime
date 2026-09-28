import { computerFields, computerInputError } from "../../../../src/plugin-sdk/computer-access.js";

/** Adapt the SDK's existing flat operation inputs; never parse natural language. */
export function readPublicComputerAction(
  params: Record<string, unknown>,
): Record<string, unknown> {
  const fields = ["desktop_ref", "observation_ref", "action_kind"];
  const kind = params.action_kind;
  switch (kind) {
    case "click":
      computerFields(params, [...fields, "x", "y", "button", "count"]);
      return {
        kind,
        point: { x: params.x, y: params.y },
        button: params.button,
        count: params.count,
      };
    case "move":
      computerFields(params, [...fields, "x", "y"]);
      return { kind, point: { x: params.x, y: params.y } };
    case "drag":
      computerFields(params, [
        ...fields,
        "from_x",
        "from_y",
        "to_x",
        "to_y",
        "button",
        "duration_ms",
      ]);
      return {
        kind,
        from: { x: params.from_x, y: params.from_y },
        to: { x: params.to_x, y: params.to_y },
        button: params.button,
        durationMs: params.duration_ms,
      };
    case "scroll":
      computerFields(params, [...fields, "delta_x", "delta_y"]);
      return { kind, deltaX: params.delta_x, deltaY: params.delta_y };
    case "type_text":
      computerFields(params, [...fields, "text"]);
      return { kind, text: params.text };
    case "press_keys":
      computerFields(params, [...fields, "keys"]);
      return { kind, keys: params.keys };
    case "focus_window":
      computerFields(params, [...fields, "window_ref"]);
      return { kind, window_ref: params.window_ref };
    default:
      return computerInputError("Select a declared computer action operation.");
  }
}
