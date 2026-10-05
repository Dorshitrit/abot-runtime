import { execFileSync } from "node:child_process";
import { expect, test } from "vitest";
import { MACOS_INPUT_SOURCE } from "../../computer-access/computer/macos-input.js";

test.skipIf(process.platform !== "darwin")("Mac key aliases resolve before dispatch without creating or posting input events", () => {
  const keysAndValidation = MACOS_INPUT_SOURCE.slice(
    MACOS_INPUT_SOURCE.indexOf("let keyCodes:"),
    MACOS_INPUT_SOURCE.indexOf("func requireVerifiedTextFocus("),
  );
  const output = execFileSync("/usr/bin/swift", ["-"], {
    input: `import Foundation\nimport CoreGraphics\n${keysAndValidation}\n` + String.raw`
struct NativeFailure: Error { let code:String; init(_ code:String) { self.code=code } }
struct WindowReference { let binding:String }
let windowReferences=[WindowReference]()
func displayBounds() -> CGRect { return CGRect(x:0,y:0,width:100,height:100) }
func validation(_ keys:[String]) -> String {
  do { try validateAction(["kind":"press_keys","keys":keys],[:]); return "ok" }
  catch let error as NativeFailure { return error.code }
  catch { return "unexpected" }
}
let aliases=["Command","Cmd","CMD","cmd","cMd","Meta","SUPER"]
let otherNames=["Control","CTRL","Shift","ALT","Option","Enter","RETURN","Tab","SPACE","Backspace","DELETE","Esc","ESCAPE","F1","f12","Home","END","PageUp","PAGEDOWN","ArrowLeft","ARROWRIGHT","ArrowDown","ARROWUP","A","z","0","9"]
let rejected=["", "CMD+L", "Command L", "not-a-key", "F13", "א", " CMD "]
let command=try nativeKey("CMD")
let control=try nativeKey("control"),shift=try nativeKey("SHIFT"),option=try nativeKey("option"),letter=try nativeKey("L")
let result:[String:Any]=[
  "commandKeys":try aliases.map { try nativeKey($0) },
  "chord":try ["CMD","L"].map { try nativeKey($0) },
  "modifiers":modifierFlag(command)==CGEventFlags.maskCommand && modifierFlag(control)==CGEventFlags.maskControl && modifierFlag(shift)==CGEventFlags.maskShift && modifierFlag(option)==CGEventFlags.maskAlternate && modifierFlag(letter).isEmpty,
  "existingNames":try otherNames.map { try nativeKey($0) },
  "valid":validation(["CMD","L"]),
  "rejected":rejected.map { validation(["Command",$0]) },
  "emptyChord":validation([]),
  "longChord":validation(Array(repeating:"L",count:9))
]
print(String(data:try JSONSerialization.data(withJSONObject:result),encoding:.utf8)!)
`, encoding: "utf8", timeout: 60_000,
  });
  expect(JSON.parse(output)).toEqual({
    commandKeys: [55, 55, 55, 55, 55, 55, 55],
    chord: [55, 37], modifiers: true,
    existingNames: [59, 59, 56, 58, 58, 36, 36, 48, 49, 51, 117, 53, 53, 122, 111, 115, 119, 116, 121, 123, 124, 125, 126, 0, 6, 29, 25],
    valid: "ok", rejected: Array(7).fill("macos_key_unsupported"),
    emptyChord: "computer_keys_invalid", longChord: "computer_keys_invalid",
  });
}, 65_000);
