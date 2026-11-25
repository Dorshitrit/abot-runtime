import { expect, test } from "vitest";
// @ts-expect-error Browser presentation module has no declaration surface.
import { computerConnectionCardSummary } from "../../web-ui/app/components/system-host/home-connection-summary.js";

const connected = {
  snapshot: {
    paired: true, connected: true, hostId: "fixture-mac", connectionId: "fixture-connection",
    identity: { name: "Fixture Mac", os: "macos", user: "fixture" },
    readiness: { ready: true, route: "companion", platforms: [] },
    capabilities: ["macos_permission_preflight_v1"],
  },
};

test("a connected badge describes connection readiness without claiming permission grants", () => {
  const result = computerConnectionCardSummary(connected, true);
  expect(result.status).toBe("Connected");
  expect(result.tone).toBe("success");
  expect(result.detail).toBe("Fixture Mac · macOS · fixture");
});

test("an action failure remains visible even when the connection is ready", () => {
  const result = computerConnectionCardSummary({ ...connected, actionError: "Reconnect the companion." }, true);
  expect(result.status).toBe("Needs attention");
  expect(result.tone).toBe("attention");
  expect(result.detail).toBe("Reconnect the companion.");
});

test("a failed refresh does not retain a successful badge from the previous snapshot", () => {
  const result = computerConnectionCardSummary({ ...connected, statusUnavailable: true }, true);
  expect(result.status).toBe("Status unavailable");
  expect(result.tone).toBe("attention");
  expect(result.detail).toContain("could not be checked");
});

test("checking and unsupported backends do not render as successful connections", () => {
  expect(computerConnectionCardSummary({ ...connected, busy: true }, true)).toMatchObject({ status: "Checking", tone: "neutral" });
  expect(computerConnectionCardSummary(connected, false)).toMatchObject({ status: "Unavailable", tone: "neutral" });
});
