import { normalizeToolInputDocumentation } from "../../../capabilities/normal-invocation/input-documentation.js";
import type {
  WorkerCapabilityControlDocumentation,
  WorkerCapabilityControlsSchema,
} from "./contracts.js";

type ControlDocumentationNormalization =
  | Readonly<{ ok: true; value?: WorkerCapabilityControlDocumentation }>
  | Readonly<{ ok: false; issueCode: string }>;

/** Bind passive documentation only to existing public control names. */
export function normalizeWorkerCapabilityControlDocumentation(
  input: unknown,
  controls: WorkerCapabilityControlsSchema,
): ControlDocumentationNormalization {
  if (input === undefined) return { ok: true };
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, issueCode: "control_documentation_invalid" };
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    return { ok: false, issueCode: "control_documentation_invalid" };
  }
  const entries: Array<
    readonly [string, WorkerCapabilityControlDocumentation[string]]
  > = [];
  for (const [controlId, documentation] of Object.entries(input)) {
    if (!Object.hasOwn(controls.properties, controlId)) {
      return { ok: false, issueCode: "control_documentation_unknown_control" };
    }
    const normalized = normalizeToolInputDocumentation(
      documentation,
      controls.properties[controlId]!,
    );
    if (!normalized.ok) {
      return { ok: false, issueCode: "control_documentation_invalid" };
    }
    if (Object.keys(normalized.value).length > 0) {
      entries.push([controlId, normalized.value]);
    }
  }
  if (entries.length === 0) return { ok: true };
  return { ok: true, value: Object.freeze(Object.fromEntries(entries)) };
}
