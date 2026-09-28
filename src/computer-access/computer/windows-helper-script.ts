import { WINDOWS_ACCESSIBILITY_SCRIPT } from "./windows-accessibility-script.js";
import { WINDOWS_CAPTURE_SCRIPT } from "./windows-capture-script.js";
import { WINDOWS_DESKTOP_SCRIPT } from "./windows-desktop-script.js";
import { WINDOWS_INPUT_SCRIPT } from "./windows-input-script.js";
import { WINDOWS_KEYBOARD_SCRIPT } from "./windows-keyboard-script.js";
import { WINDOWS_NATIVE_SCRIPT } from "./windows-native-script.js";
import { WINDOWS_TOPOLOGY_SCRIPT } from "./windows-topology-script.js";

/** Focused C# owners compose one ephemeral process; no passive observation is started. */
export const WINDOWS_COMPUTER_SOURCE = [
  WINDOWS_NATIVE_SCRIPT,
  WINDOWS_TOPOLOGY_SCRIPT,
  WINDOWS_DESKTOP_SCRIPT,
  WINDOWS_CAPTURE_SCRIPT,
  WINDOWS_ACCESSIBILITY_SCRIPT,
  WINDOWS_INPUT_SCRIPT,
  WINDOWS_KEYBOARD_SCRIPT,
].join("\n");
