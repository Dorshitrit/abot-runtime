import { execFileSync } from "node:child_process";
import { describe, expect, test } from "vitest";
import { MACOS_PERMISSION_GATE, MACOS_PERMISSION_HELPER, MACOS_PERMISSION_INPUT } from "../../computer-access/computer/macos-permission-helper.js";

describe.skipIf(process.platform !== "darwin")("Mac permission-only preparation", () => {
  test("the actual helper typechecks against the SDK without checking or requesting permissions", () => {
    execFileSync("/usr/bin/swiftc", ["-typecheck", "-"], {
      input: MACOS_PERMISSION_HELPER, encoding: "utf8", timeout: 60_000,
    });
  }, 65_000);

  test("real Swift gate requests only the selected missing permission; checks do not prompt", () => {
    const source = `import Foundation\n${MACOS_PERMISSION_GATE}\n${MACOS_PERMISSION_INPUT}\n` + String.raw`
func scenario(_ action: String, _ alreadyGranted: Bool) -> [String: Any] {
  var screen = alreadyGranted, accessibility = alreadyGranted
  var requests = [String]()
  let permissions = prepareMacPermissions(
    action: action, screenGranted: { screen }, accessibilityGranted: { accessibility },
    requestScreen: { requests.append("screen"); screen = true },
    requestAccessibility: { requests.append("accessibility"); accessibility = true }
  )
  return ["permissions": permissions, "requests": requests]
}
let scenarios = ["check": scenario("check", false), "screen": scenario("screen_recording", false),
  "argument": scenario(action, false),
  "accessibility": scenario("accessibility", false), "granted": scenario("screen_recording", true)]
let data = try JSONSerialization.data(withJSONObject: scenarios)
print(String(data: data, encoding: .utf8)!)
`;
    const output = execFileSync("/usr/bin/swift", ["-swift-version", "5", "-e", source, "accessibility"], {
      encoding: "utf8", timeout: 60_000,
    });
    expect(JSON.parse(output)).toEqual({
      check: { permissions: { screenRecording: "required", accessibility: "required" }, requests: [] },
      screen: { permissions: { screenRecording: "granted", accessibility: "required" }, requests: ["screen"] },
      accessibility: { permissions: { screenRecording: "required", accessibility: "granted" }, requests: ["accessibility"] },
      argument: { permissions: { screenRecording: "required", accessibility: "granted" }, requests: ["accessibility"] },
      granted: { permissions: { screenRecording: "granted", accessibility: "granted" }, requests: [] },
    });
  }, 65_000);
});
