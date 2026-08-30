import { createHash } from "node:crypto";

import { exactKeys, isRecord } from "../../validation/strict-record.js";
import {
  isRoleCapabilityId,
  ROLE_CAPABILITY_INVOCATION_CONTROLS_JSON_MAX_LENGTH,
  ROLE_CAPABILITY_INVOCATION_INTENT_MAX_LENGTH,
  ROLE_CAPABILITY_SELECTION_INVOCATION_LIMIT_MAX,
  type RoleCallFrame,
  type RoleCapabilitySelectionProjection,
  type RoleCapabilitySelectionReconsideration,
} from "./contracts.js";
import { parseRoleCallWorkerCapabilityScope } from "./worker-capability-scope.js";
import { normalizeEstablishedRoleCallWorkingDirectory } from "./working-directory.js";

export function normalizeRoleCapabilitySelectionProjection(
  input: unknown,
): RoleCapabilitySelectionProjection | undefined {
  if (
    !isRecord(input) ||
    !exactKeys(input, [
      "action",
      "invocations",
      "workingDirectory",
      "activeCapabilityCatalogGroupIds",
    ])
  ) {
    return undefined;
  }
  if (
    (input.action !== "invoke_capability" &&
      input.action !== "invoke_capabilities") ||
    !Array.isArray(input.invocations) ||
    input.invocations.length < 1 ||
    input.invocations.length > ROLE_CAPABILITY_SELECTION_INVOCATION_LIMIT_MAX ||
    (input.action === "invoke_capability"
      ? input.invocations.length !== 1
      : input.invocations.length < 2)
  ) {
    return undefined;
  }
  const scope = parseRoleCallWorkerCapabilityScope({
    catalogGroupIds: input.activeCapabilityCatalogGroupIds,
  });
  if (!scope) return undefined;
  const workingDirectory =
    input.workingDirectory === null
      ? null
      : normalizeEstablishedRoleCallWorkingDirectory(input.workingDirectory);
  if (workingDirectory === undefined) return undefined;

  const invocations = input.invocations.map((entry) => {
    if (
      !isRecord(entry) ||
      !exactKeys(entry, ["capabilityId", "intent", "selectionControlsJson"]) ||
      !isRoleCapabilityId(entry.capabilityId) ||
      typeof entry.intent !== "string" ||
      entry.intent.length === 0 ||
      entry.intent.length > ROLE_CAPABILITY_INVOCATION_INTENT_MAX_LENGTH ||
      entry.intent.trim() !== entry.intent ||
      typeof entry.selectionControlsJson !== "string" ||
      entry.selectionControlsJson.length < 2 ||
      entry.selectionControlsJson.length >
        ROLE_CAPABILITY_INVOCATION_CONTROLS_JSON_MAX_LENGTH ||
      canonicalizeControlsJson(entry.selectionControlsJson) !==
        entry.selectionControlsJson
    ) {
      return undefined;
    }
    return Object.freeze({
      capabilityId: entry.capabilityId,
      intent: entry.intent,
      selectionControlsJson: entry.selectionControlsJson,
    });
  });
  if (invocations.some((entry) => entry === undefined)) return undefined;
  return Object.freeze({
    action: input.action,
    invocations: Object.freeze(
      invocations as RoleCapabilitySelectionProjection["invocations"],
    ),
    workingDirectory,
    activeCapabilityCatalogGroupIds: scope.catalogGroupIds,
  });
}

export function createRoleCapabilitySelectionProjection(
  input: Readonly<{
    action: "invoke_capability" | "invoke_capabilities";
    invocations: readonly Readonly<{
      capabilityId: string;
      intent: string;
      selectionControls?: Readonly<Record<string, unknown>>;
    }>[];
    workingDirectory: string | null;
    activeCapabilityCatalogGroupIds: readonly string[];
  }>,
): RoleCapabilitySelectionProjection {
  const selection = normalizeRoleCapabilitySelectionProjection({
    action: input.action,
    invocations: input.invocations.map((invocation) => ({
      capabilityId: invocation.capabilityId,
      intent: invocation.intent,
      selectionControlsJson: canonicalizeControls(
        invocation.selectionControls ?? {},
      ),
    })),
    workingDirectory: input.workingDirectory,
    activeCapabilityCatalogGroupIds: input.activeCapabilityCatalogGroupIds,
  });
  if (!selection) {
    throw new Error("role_capability_selection_projection_invalid");
  }
  return selection;
}

export function createRoleCapabilitySelectionFingerprint(
  input: Readonly<{
    steeringVersion: number;
    selection: RoleCapabilitySelectionProjection;
  }>,
): string {
  if (
    !Number.isSafeInteger(input.steeringVersion) ||
    input.steeringVersion < 0
  ) {
    throw new Error("role_capability_selection_steering_version_invalid");
  }
  const selection = normalizeRoleCapabilitySelectionProjection(input.selection);
  if (!selection) {
    throw new Error("role_capability_selection_projection_invalid");
  }
  const canonical = JSON.stringify({
    steeringVersion: input.steeringVersion,
    selection,
  });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

export function isImmediateRoleCapabilitySelectionReconsideration(input: {
  call: RoleCallFrame;
  steeringVersion: number;
}): input is {
  call: RoleCallFrame & {
    lastCapabilitySelectionReconsideration: RoleCapabilitySelectionReconsideration;
  };
  steeringVersion: number;
} {
  const reconsideration = input.call.lastCapabilitySelectionReconsideration;
  const activeScope = input.call.workerCapabilityScope?.catalogGroupIds;
  return (
    reconsideration !== undefined &&
    input.call.activationCount === reconsideration.invocationAttempt + 1 &&
    input.steeringVersion === reconsideration.steeringVersion &&
    activeScope !== undefined &&
    sameStringArray(
      activeScope,
      reconsideration.selection.activeCapabilityCatalogGroupIds,
    ) &&
    (input.call.workingDirectory === undefined ||
      input.call.workingDirectory ===
        reconsideration.selection.workingDirectory)
  );
}

function canonicalizeControls(
  input: Readonly<Record<string, unknown>>,
): string {
  const canonical = canonicalizeJsonValue(input);
  if (!isRecord(canonical)) {
    throw new Error("role_capability_selection_controls_invalid");
  }
  return JSON.stringify(canonical);
}

function canonicalizeControlsJson(input: string): string | undefined {
  try {
    const parsed = JSON.parse(input) as unknown;
    return isRecord(parsed) ? canonicalizeControls(parsed) : undefined;
  } catch {
    return undefined;
  }
}

function canonicalizeJsonValue(input: unknown): unknown {
  if (
    input === null ||
    typeof input === "string" ||
    typeof input === "boolean"
  ) {
    return input;
  }
  if (typeof input === "number") {
    if (!Number.isFinite(input)) {
      throw new Error("role_capability_selection_controls_invalid");
    }
    return input;
  }
  if (Array.isArray(input)) {
    return input.map(canonicalizeJsonValue);
  }
  if (!isRecord(input)) {
    throw new Error("role_capability_selection_controls_invalid");
  }
  return Object.fromEntries(
    Object.keys(input)
      .sort()
      .map((key) => [key, canonicalizeJsonValue(input[key])]),
  );
}

function sameStringArray(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}
