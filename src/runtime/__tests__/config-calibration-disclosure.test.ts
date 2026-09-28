import { afterEach, describe, expect, test, vi } from "vitest";

// prettier-ignore
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { createConfigCalibrationDisclosure, rememberCalibrationDisclosure } from "../../web-ui/app/components/config-workspace/calibration-disclosure.js";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { createConfigWorkspaceEvents } from "../../web-ui/app/components/config-workspace/workspace-events.js";

function createHarness() {
  const profiles = [
    {
      open: true,
      dataset: { calibrationKey: "model:local:draft" },
      input: { value: "Unsaved name" },
    },
    {
      open: true,
      dataset: { calibrationKey: "model:local:review" },
      input: { value: "Unsaved description" },
    },
  ];
  const section = {
    open: true,
    dataset: { calibrationSectionKey: "model:local" },
    children: profiles,
  };
  const state = {
    expandedCalibrationSections: new Set(["model:local"]),
    expandedCalibrationKeys: new Set([
      "model:local:draft",
      "model:local:review",
    ]),
    rawDraftsByKey: new Map([["model:local", "unsaved draft"]]),
  };
  const root = Object.freeze({
    querySelectorAll: vi.fn(() => [section, ...profiles]),
  });
  const disclosure = createConfigCalibrationDisclosure({ state, root });
  return { disclosure, profiles, root, state, section };
}

afterEach(() => vi.restoreAllMocks());

describe("Config calibration disclosure lifecycle", () => {
  test("collapses every profile on entry without fetching or replacing edited nodes", () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Unexpected fetch"));
    const { disclosure, profiles, root, state } = createHarness();
    const originalNodes = [...profiles];
    const originalInputs = profiles.map((profile) => profile.input);
    const originalDrafts = state.rawDraftsByKey;

    disclosure.setActive(true);

    expect(root.querySelectorAll).toHaveBeenCalledExactlyOnceWith(
      "details[data-calibration-key], details[data-calibration-section-key]",
    );
    expect(profiles.map((profile) => profile.open)).toEqual([false, false]);
    expect(state.expandedCalibrationKeys.size).toBe(0);
    for (const [index, profile] of profiles.entries()) {
      expect(profile).toBe(originalNodes[index]);
      expect(profile.input).toBe(originalInputs[index]);
    }
    expect(profiles.map((profile) => profile.input.value)).toEqual([
      "Unsaved name",
      "Unsaved description",
    ]);
    expect(state.rawDraftsByKey).toBe(originalDrafts);
    expect(state.rawDraftsByKey.get("model:local")).toBe("unsaved draft");
    expect(fetch).not.toHaveBeenCalled();
  });

  test("preserves explicit expansion during repeated active notifications and editing", () => {
    const { disclosure, profiles, root, state } = createHarness();
    disclosure.setActive(true);
    profiles[0]!.open = true;
    profiles[0]!.input.value = "Continue editing";
    state.expandedCalibrationKeys.add("model:local:draft");

    disclosure.setActive(true);
    disclosure.setActive(true);

    expect(profiles[0]!.open).toBe(true);
    expect(profiles[0]!.input.value).toBe("Continue editing");
    expect(state.expandedCalibrationKeys.has("model:local:draft")).toBe(true);
    expect(root.querySelectorAll).toHaveBeenCalledOnce();
  });

  test("closes current rerendered profiles only after leaving and entering again", () => {
    const { disclosure, profiles, root, state } = createHarness();
    disclosure.setActive(true);
    const currentProfile = {
      open: true,
      dataset: { calibrationKey: "model:local:draft" },
      input: { value: "Rerendered draft" },
    };
    profiles[0] = currentProfile;
    state.expandedCalibrationKeys.add("model:local:draft");

    disclosure.setActive(true);
    expect(currentProfile.open).toBe(true);
    disclosure.setActive(false);
    expect(currentProfile.open).toBe(true);
    expect(state.expandedCalibrationKeys.size).toBe(1);
    disclosure.setActive(true);

    expect(currentProfile.open).toBe(false);
    expect(profiles[0]).toBe(currentProfile);
    expect(currentProfile.input.value).toBe("Rerendered draft");
    expect(state.expandedCalibrationKeys.size).toBe(0);
    expect(root.querySelectorAll).toHaveBeenCalledTimes(2);
  });

  test("closing the outer section preserves inner expansion and unsaved nodes until Config is entered again", () => {
    const { disclosure, profiles, state, section } = createHarness();
    const input = profiles[0]!.input;
    const children = section.children;
    section.open = false;
    rememberCalibrationDisclosure(state, section);
    expect(state.expandedCalibrationSections.size).toBe(0);
    expect(state.expandedCalibrationKeys.has("model:local:draft")).toBe(true);
    expect(profiles[0]!.open).toBe(true);
    expect(section.children).toBe(children);
    expect(profiles[0]!.input).toBe(input);
    expect(input.value).toBe("Unsaved name");

    section.open = true;
    rememberCalibrationDisclosure(state, section);
    expect(state.expandedCalibrationSections.has("model:local")).toBe(true);
    expect(profiles[0]!.open).toBe(true);
    profiles[0]!.open = false;
    rememberCalibrationDisclosure(state, profiles[0]);
    expect(state.expandedCalibrationKeys.has("model:local:draft")).toBe(false);
    expect(state.expandedCalibrationSections.has("model:local")).toBe(true);
    expect(() => rememberCalibrationDisclosure(state, {})).not.toThrow();

    disclosure.setActive(true);
    expect(section.open).toBe(false);
    expect(state.expandedCalibrationSections.size).toBe(0);
    expect(profiles[0]!.input).toBe(input);
    expect(input.value).toBe("Unsaved name");
  });
  test("records outer disclosure toggles through the native capture listener", () => {
    const { state, section } = createHarness();
    const addEventListener = vi.fn();
    createConfigWorkspaceEvents({
      state,
      dom: {
        configDashboard: { addEventListener },
        refreshConfigButton: { addEventListener: vi.fn() },
      },
      eventTarget: {},
    }).bind();
    const registration = addEventListener.mock.calls.find(
      ([event]) => event === "toggle",
    )!;
    expect(registration[2]).toBe(true);
    section.open = false;
    registration[1]({ target: section });
    expect(state.expandedCalibrationSections.size).toBe(0);
    section.open = true;
    registration[1]({ target: section });
    expect(state.expandedCalibrationSections.has("model:local")).toBe(true);
    expect(state.expandedCalibrationKeys.size).toBe(2);
  });
});
