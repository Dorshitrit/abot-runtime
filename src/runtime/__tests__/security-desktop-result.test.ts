import { describe, expect, it } from "vitest";
import { protectDesktopResult as protectInternal } from "../../computer-access/security/desktop-result.js";
import { protectDesktopResult as protectSystem } from "../../../plugins/system/source/security/desktop-result.js";
import type { NativeComputerResult } from "../../computer-access/computer/native-protocol.js";
import { desktopFixture } from "./computer-plugin-fixtures.js";
import { acceptedDispatch } from "./computer-companion-fixtures.js";

const secret = "api_key=synthetic-secret";
const binding = "password=opaque-mechanical-identity";
function fixture(): NativeComputerResult {
  const base = desktopFixture();
  return {
    ...base,
    desktop: { ...base.desktop, binding, coordinateSpace: "physical_pixels" },
    focusedWindow: binding,
    windows: [{ ...base.windows[0]!, binding, application: "Editor" }],
    observation: {
      ...base.observation!,
      accessibility: [
        {
          role: "textbox",
          name: "Document",
          value: "Ordinary text",
          focused: true,
          bounds: base.desktop.bounds,
        },
      ],
    },
    dispatch: acceptedDispatch,
  };
}
type Change = (result: NativeComputerResult) => NativeComputerResult;
const fields: Array<[string, Change]> = [
  ["desktop name", (r) => ({ ...r, desktop: { ...r.desktop, name: secret } })],
  [
    "desktop reason",
    (r) => ({ ...r, desktop: { ...r.desktop, reason: secret } }),
  ],
  ...(["capture", "accessibility", "input", "windows"] as const).map(
    (key): [string, Change] => [
      `${key} capability reason`,
      (r) => ({
        ...r,
        desktop: {
          ...r.desktop,
          capabilities: {
            ...r.desktop.capabilities,
            [key]: { ...r.desktop.capabilities[key], reason: secret },
          },
        },
      }),
    ],
  ),
  [
    "window title",
    (r) => ({ ...r, windows: [{ ...r.windows[0]!, title: secret }] }),
  ],
  [
    "application name",
    (r) => ({ ...r, windows: [{ ...r.windows[0]!, application: secret }] }),
  ],
  ...(["role", "name", "value"] as const).map((key): [string, Change] => [
    `accessibility ${key}`,
    (r) => ({
      ...r,
      observation: {
        ...r.observation!,
        accessibility: [{ ...r.observation!.accessibility[0]!, [key]: secret }],
      },
    }),
  ]),
  [
    "dispatch reason",
    (r) => ({ ...r, dispatch: { ...acceptedDispatch, reason: secret } }),
  ],
  [
    "error message",
    (r) => ({ ...r, error: { code: "native_failure", message: secret } }),
  ],
  [
    "error code",
    (r) => ({ ...r, error: { code: secret, message: "Native diagnostic." } }),
  ],
  [
    "capture timestamp",
    (r) => ({ ...r, observation: { ...r.observation!, capturedAt: secret } }),
  ],
];

describe.each([
  ["internal producer", protectInternal],
  ["independent SYSTEM", protectSystem],
] as const)("%s desktop content protection", (_name, protect) => {
  it.each(fields)(
    "masks %s and destroys its associated image",
    (_field, change) => {
      const input = change(fixture());
      const output = protect(input);
      expect(JSON.stringify(output)).not.toContain(secret);
      expect(JSON.stringify(output)).toContain("[REDACTED]");
      expect(output.image).toBeUndefined();
      expect([...input.image!.bytes]).toEqual([0, 0, 0]);
      expect(output.dispatch).toMatchObject(acceptedDispatch);
      expect(output.desktop.binding).toBe(binding);
      expect(output.focusedWindow).toBe(binding);
      expect(output.windows[0]!.binding).toBe(binding);
      expect(output.desktop.bounds).toEqual(input.desktop.bounds);
      expect(output.observation!.capturedAt).toBe(
        _field === "capture timestamp"
          ? "[REDACTED]"
          : input.observation!.capturedAt,
      );
      expect(output.observation!.region).toEqual(input.observation!.region);
    },
  );

  it("leaves ordinary images and mechanical control fields unchanged without inspecting pixels", () => {
    const input = {
      ...fixture(),
      error: { code: "native_failure", message: "Native diagnostic." },
    };
    const output = protect(input);
    expect(output).toEqual(input);
    expect(output.image!.bytes).toBe(input.image!.bytes);
    expect([...input.image!.bytes]).toEqual([1, 2, 3]);
  });

  it("preserves the original failure code and dispatch receipt when removing an image", () => {
    const input = {
      ...fixture(),
      error: { code: "native_failure", message: secret },
    };
    expect(protect(input)).toMatchObject({
      error: { code: "native_failure", message: "[REDACTED]" },
      dispatch: acceptedDispatch,
    });
  });

  it("masks inspect-only text without inventing an input receipt or requiring an image", () => {
    const input = fixture();
    const output = protect({
      desktop: { ...input.desktop, name: secret },
      windows: input.windows,
    });
    expect(output.desktop.name).toBe("[REDACTED]");
    expect(output.dispatch).toBeUndefined();
    expect(output.image).toBeUndefined();
    expect(output.error).toBeUndefined();
  });

  it("fails closed with a fixed error after a scanner throws and retains mechanical receipts", () => {
    const input = fixture();
    const output = protect(input, () => {
      throw new Error(secret);
    });
    expect(output.error!.code).toBe("computer_observation_protection_failed");
    expect(JSON.stringify(output)).not.toContain(secret);
    expect(output.windows).toEqual([]);
    expect(output.observation).toBeUndefined();
    expect(output.image).toBeUndefined();
    expect(output.desktop.binding).toBe(binding);
    expect(output.dispatch).toEqual(acceptedDispatch);
    expect([...input.image!.bytes]).toEqual([0, 0, 0]);
  });

  it("does not forward undeclared nested native observation fields", () => {
    const input = fixture();
    const output = protect({
      ...input,
      desktop: { ...input.desktop, extra: secret },
      windows: [{ ...input.windows[0]!, extra: secret }],
      observation: {
        ...input.observation!,
        extra: secret,
        accessibility: [
          { ...input.observation!.accessibility[0]!, extra: secret },
        ],
      },
      dispatch: { ...acceptedDispatch, extra: secret },
    } as unknown as NativeComputerResult);
    expect(JSON.stringify(output)).not.toContain(secret);
  });
});
