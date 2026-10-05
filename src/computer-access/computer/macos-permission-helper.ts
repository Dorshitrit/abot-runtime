/** Permission checks never enumerate windows, capture pixels, or inject input. */
export const MACOS_PERMISSION_GATE = String.raw`
func prepareMacPermissions(
  action: String,
  screenGranted: () -> Bool,
  accessibilityGranted: () -> Bool,
  requestScreen: () -> Void,
  requestAccessibility: () -> Void
) -> [String: String] {
  if action == "screen_recording" && !screenGranted() { requestScreen() }
  if action == "accessibility" && !accessibilityGranted() { requestAccessibility() }
  return ["screenRecording": screenGranted() ? "granted" : "required",
    "accessibility": accessibilityGranted() ? "granted" : "required"]
}
`;

export const MACOS_PERMISSION_INPUT = String.raw`
let action = CommandLine.arguments.last ?? "check"
guard ["check", "screen_recording", "accessibility"].contains(action) else { exit(2) }
`;

export const MACOS_PERMISSION_HELPER = String.raw`
import Foundation
import CoreGraphics
import ApplicationServices
${MACOS_PERMISSION_GATE}
${MACOS_PERMISSION_INPUT}
let result = prepareMacPermissions(
  action: action,
  screenGranted: { CGPreflightScreenCaptureAccess() },
  accessibilityGranted: { AXIsProcessTrusted() },
  requestScreen: { _ = CGRequestScreenCaptureAccess() },
  requestAccessibility: {
    let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
    _ = AXIsProcessTrustedWithOptions(options)
  }
)
let data = try JSONSerialization.data(withJSONObject: result)
print(String(data: data, encoding: .utf8)!)
`;
