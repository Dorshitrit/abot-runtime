import type { ToolNormalInvocationInput } from "../../../capabilities/tool-types.js";
import { stripToolInputDocumentation } from "../../../capabilities/normal-invocation/input-documentation.js";
import { normalizeWorkerCapabilityControlDocumentation } from "../../orchestration/worker-capabilities/control-documentation.js";
import { normalizeWorkerCapabilityControlsSchema } from "../../orchestration/worker-capabilities/controls.js";
import type {
  WorkerCapabilityControlDocumentation,
  WorkerCapabilityControlsSchema,
} from "../../orchestration/worker-capabilities/contracts.js";

type RegisteredToolControlsProjection =
  | Readonly<{
      ok: true;
      controls: WorkerCapabilityControlsSchema;
      controlDocumentation?: WorkerCapabilityControlDocumentation;
    }>
  | Readonly<{ ok: false; issueCode: string }>;

/** Keep documentation out of the provider schema and executable controls. */
export function projectRegisteredToolCapabilityControls(
  input: ToolNormalInvocationInput,
): RegisteredToolControlsProjection {
  if (
    typeof input !== "object" || input === null ||
    typeof input.properties !== "object" || input.properties === null ||
    Array.isArray(input.properties)
  ) {
    return { ok: false, issueCode: "controls_schema_invalid" };
  }
  const documentation: Array<readonly [string, unknown]> = [];
  for (const [controlId, property] of Object.entries(input.properties)) {
    if (typeof property !== "object" || property === null || Array.isArray(property)) {
      return { ok: false, issueCode: "controls_schema_property_invalid" };
    }
    const entry = {
      ...(Object.hasOwn(property, "description")
        ? { description: property.description }
        : {}),
      ...(Object.hasOwn(property, "example")
        ? { example: property.example }
        : {}),
    };
    if (Object.keys(entry).length > 0) documentation.push([controlId, entry]);
  }
  const controls = normalizeWorkerCapabilityControlsSchema(
    stripToolInputDocumentation(input),
  );
  if (!controls.ok) return controls;
  const normalized = normalizeWorkerCapabilityControlDocumentation(
    Object.fromEntries(documentation),
    controls.value,
  );
  if (!normalized.ok) return normalized;
  return {
    ok: true,
    controls: controls.value,
    ...(normalized.value ? { controlDocumentation: normalized.value } : {}),
  };
}
