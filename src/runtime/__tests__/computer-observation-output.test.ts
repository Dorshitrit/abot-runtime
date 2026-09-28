import { expect, test } from "vitest";
import {
  COMPUTER_OBSERVATION_OUTPUT_MAX_BYTES,
  serializeComputerDesktops,
  serializeComputerObservation,
} from "../../../plugins/system/source/computer/observation-output.js";
import {
  successResult,
  failureResult,
  PLUGIN_RESULT_SERIALIZED_MAX_BYTES,
} from "../../plugin-sdk/results.js";

const rectangle = { x: -1920, y: 0, width: 1920, height: 1080 };
const receipt = {
  status: "accepted",
  requestedInputCount: 2,
  acceptedInputCount: 2,
};
const data = {
  desktop_ref: "desktop-1",
  observation_ref: "observation-1",
  dispatch: receipt,
  imageAvailable: true,
  requestedEffectVerified: false,
  observationMeta: { kind: "volatile_external", carryPolicy: "never" } as const,
};
const image = {
  kind: "tool_image_v1" as const,
  id: "image-12345678-1234-1234-1234-123456789012",
  mimeType: "image/png" as const,
  size: 123,
  width: 1920,
  height: 1080,
  sha256: "0".repeat(64),
};

function description() {
  return {
    platform: "windows",
    displayTarget: "windows",
    transport: "native",
    computerName: "my-computer",
    imageWidth: 1920,
    imageHeight: 1080,
    coordinateSpace: "image_pixels",
    targetingGuarantee: "verified_window",
    capturedAt: "2026-09-24T00:00:00Z",
    available: true,
    accessibilityTruncated: false,
    accessibility: Array.from({ length: 50 }, (_, index) => ({
      role: "text",
      name: `${index}:` + '"\\'.repeat(170),
      bounds: rectangle,
    })),
    windows: Array.from({ length: 50 }, (_, index) => ({
      window_ref: `window-${index}`,
      title: `${index}:` + '"\\'.repeat(170),
      bounds: rectangle,
      focused: index === 0,
    })),
  };
}

test("quote-heavy observations retain exact prefix nodes, geometry, bindings and accepted input while fitting the SDK envelope", () => {
  const original = description();
  const unchanged = structuredClone(original);
  expect(Buffer.byteLength(JSON.stringify(original))).toBeGreaterThan(
    70 * 1024,
  );
  const output = serializeComputerObservation(original, data);
  const projected = JSON.parse(output);
  expect(Buffer.byteLength(output)).toBeLessThanOrEqual(
    COMPUTER_OBSERVATION_OUTPUT_MAX_BYTES,
  );
  expect(projected).toMatchObject({
    ...data,
    imageWidth: 1920,
    imageHeight: 1080,
    coordinateSpace: "image_pixels",
    computerName: "my-computer",
  });
  for (const field of ["accessibility", "windows"] as const) {
    expect(projected[field]).toEqual(
      original[field].slice(0, projected[field].length),
    );
    if (projected[field].length === original[field].length) continue;
    expect(projected[`${field}Truncated`]).toBe(true);
    expect(projected.outputCoverage[field]).toEqual({
      retainedCount: projected[field].length,
      omittedCount: original[field].length - projected[field].length,
    });
  }
  const result = successResult({ output, data, media: [image] });
  expect(result.ok).toBe(true);
  expect(result.media).toEqual([image]);
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(
    PLUGIN_RESULT_SERIALIZED_MAX_BYTES,
  );
  expect(original).toEqual(unchanged);
});

test("desktop list pruning preserves every offered desktop identity and reports coverage independently", () => {
  const desktops = [1, 2, 3].map((index) => ({
    ...description(),
    desktop_ref: `desktop-${index}`,
  }));
  const output = serializeComputerDesktops(desktops);
  const projected = JSON.parse(output).desktops;
  expect(
    projected.map((item: Record<string, unknown>) => item.desktop_ref),
  ).toEqual(["desktop-1", "desktop-2", "desktop-3"]);
  expect(Buffer.byteLength(output)).toBeLessThanOrEqual(
    COMPUTER_OBSERVATION_OUTPUT_MAX_BYTES,
  );
  expect(
    successResult({ output, data: { observationMeta: data.observationMeta } })
      .ok,
  ).toBe(true);
  for (let index = 0; index < projected.length; index++) {
    for (const field of ["accessibility", "windows"] as const) {
      expect(projected[index][field]).toEqual(
        desktops[index]![field].slice(0, projected[index][field].length),
      );
      if (!projected[index].outputCoverage?.[field]) continue;
      expect(projected[index].outputCoverage[field].omittedCount).toBe(
        desktops[index]![field].length - projected[index][field].length,
      );
    }
  }
});

test("ordinary observations stay byte-identical and preserve existing native coverage flags", () => {
  const original = {
    ...description(),
    accessibility: [],
    windows: [],
    accessibilityTruncated: true,
  };
  expect(serializeComputerObservation(original, data)).toBe(
    JSON.stringify({ ...original, ...data }),
  );
  expect(serializeComputerDesktops([original])).toBe(
    JSON.stringify({ desktops: [original] }),
  );
});

test("an oversized non-array base produces a bounded explicit error while retaining the accepted receipt and image reference", () => {
  const output = serializeComputerObservation(
    {
      ...description(),
      accessibility: [],
      windows: [],
      reason: '"'.repeat(60 * 1024),
    },
    data,
  );
  const projected = JSON.parse(output);
  expect(projected).toMatchObject({
    ...data,
    imageWidth: 1920,
    imageHeight: 1080,
    outputError: { code: "computer_observation_metadata_too_large" },
  });
  expect(projected).not.toHaveProperty("reason");
  const result = failureResult({
    output,
    data,
    media: [image],
    errorCode: "computer_capture_failed",
    message: "Capture metadata is incomplete.",
  });
  expect(result.errorCode).toBe("computer_capture_failed");
  expect(result.data).toMatchObject({ dispatch: receipt });
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(
    PLUGIN_RESULT_SERIALIZED_MAX_BYTES,
  );
});
