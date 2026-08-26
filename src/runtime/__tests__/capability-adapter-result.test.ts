import { describe, expect, test } from "vitest";

import {
  CAPABILITY_ADAPTER_RESULT_SERIALIZED_MAX_BYTES,
  captureLegacyCapabilityAdapterResult,
  normalizeCapabilityAdapterResult,
  type CapabilityAdapterResult,
} from "../orchestration/capability-adapters/index.js";

function genericResult(payload: string): CapabilityAdapterResult {
  return {
    kind: "generic_capability_result_v1",
    authority: "capability_adapter",
    status: "executed",
    ok: true,
    payload,
  };
}

function payloadForSerializedBytes(byteCount: number): string {
  const emptyResultBytes = Buffer.byteLength(
    JSON.stringify(genericResult("")),
    "utf8",
  );
  return "x".repeat(byteCount - emptyResultBytes);
}

describe("Capability adapter result normalization", () => {
  test("exports a 256 KiB serialized result boundary", () => {
    expect(CAPABILITY_ADAPTER_RESULT_SERIALIZED_MAX_BYTES).toBe(256 * 1024);
  });

  test("preserves complete registered tool result content within the boundary", () => {
    const input = {
      kind: "registered_tool_execution_result_v1",
      authority: "registered_plugin",
      status: "executed",
      result: {
        ok: true,
        tool: "publication_snapshot",
        output: "  exact aggregate output\n",
        producedNewInformation: true,
        actions: [
          {
            type: "inspect_target",
            target: "publication-1",
            details: "  exact action detail  ",
          },
        ],
        data: {
          publications: [
            { id: "publication-1", visibility: "draft", body: "exact body" },
          ],
        },
      },
    } as const;

    expect(normalizeCapabilityAdapterResult(input)).toEqual({
      ok: true,
      value: input,
    });
  });

  test("preserves exact JSON-safe content at the serialized result boundary", () => {
    const input = genericResult(
      payloadForSerializedBytes(CAPABILITY_ADAPTER_RESULT_SERIALIZED_MAX_BYTES),
    );
    expect(Buffer.byteLength(JSON.stringify(input), "utf8")).toBe(
      CAPABILITY_ADAPTER_RESULT_SERIALIZED_MAX_BYTES,
    );

    const normalized = normalizeCapabilityAdapterResult(input);

    expect(normalized).toEqual({ ok: true, value: input });
  });

  test("rejects a JSON-safe result one serialized byte over the boundary", () => {
    const input = genericResult(
      payloadForSerializedBytes(
        CAPABILITY_ADAPTER_RESULT_SERIALIZED_MAX_BYTES + 1,
      ),
    );
    expect(Buffer.byteLength(JSON.stringify(input), "utf8")).toBe(
      CAPABILITY_ADAPTER_RESULT_SERIALIZED_MAX_BYTES + 1,
    );

    expect(normalizeCapabilityAdapterResult(input)).toEqual({
      ok: false,
      code: "result_too_large",
    });
  });

  test("applies the same hard boundary to captured legacy adapter results", () => {
    expect(
      captureLegacyCapabilityAdapterResult({
        outcome: "succeeded",
        observedEffect: "observation",
        summary: "captured legacy result",
        referenceData: "x".repeat(
          CAPABILITY_ADAPTER_RESULT_SERIALIZED_MAX_BYTES,
        ),
      }),
    ).toEqual({ ok: false, code: "result_too_large" });
  });

  test("rejects cyclic structured evidence", () => {
    const payload: Record<string, unknown> = {};
    payload.self = payload;

    expect(
      normalizeCapabilityAdapterResult({
        kind: "generic_capability_result_v1",
        authority: "capability_adapter",
        status: "executed",
        ok: true,
        payload,
      }),
    ).toMatchObject({ ok: false });
  });

  test("rejects non-finite registered tool data", () => {
    expect(
      normalizeCapabilityAdapterResult({
        kind: "registered_tool_execution_result_v1",
        authority: "registered_plugin",
        status: "executed",
        result: {
          ok: true,
          tool: "metrics_reader",
          output: "Observed one metric.",
          producedNewInformation: true,
          data: { value: Number.POSITIVE_INFINITY },
        },
      }),
    ).toEqual({ ok: false, code: "result_invalid" });
  });

  test("rejects accessors without evaluating them", () => {
    let getterCalls = 0;
    const payload = Object.defineProperty({}, "secret", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return "must-not-run";
      },
    });

    expect(
      normalizeCapabilityAdapterResult({
        kind: "generic_capability_result_v1",
        authority: "capability_adapter",
        status: "executed",
        ok: true,
        payload,
      }),
    ).toMatchObject({ ok: false });
    expect(getterCalls).toBe(0);
  });

  test("rejects indexed array accessors without evaluating them", () => {
    let getterCalls = 0;
    const payload: unknown[] = [];
    Object.defineProperty(payload, 0, {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return "must-not-run";
      },
    });

    expect(
      normalizeCapabilityAdapterResult({
        kind: "generic_capability_result_v1",
        authority: "capability_adapter",
        status: "executed",
        ok: true,
        payload,
      }),
    ).toMatchObject({ ok: false });
    expect(getterCalls).toBe(0);
  });
});
