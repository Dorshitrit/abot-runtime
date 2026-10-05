import { execFileSync } from "node:child_process";
import { expect, test } from "vitest";
import { MACOS_DESKTOP_SOURCE } from "../../computer-access/computer/macos-desktop.js";
import { MACOS_CAPTURE_SOURCE } from "../../computer-access/computer/macos-capture.js";
import { MACOS_COMPUTER_HELPER } from "../../computer-access/computer/macos-helper.js";

test.skipIf(process.platform !== "darwin")("native rectangle roundtrips pass capture guards while changed or invalid geometry still fails", () => {
  const rectJSON = MACOS_DESKTOP_SOURCE.slice(MACOS_DESKTOP_SOURCE.indexOf("func rectJSON("), MACOS_DESKTOP_SOURCE.indexOf("func boundedText("));
  const readRect = MACOS_DESKTOP_SOURCE.slice(MACOS_DESKTOP_SOURCE.indexOf("func readRect("), MACOS_DESKTOP_SOURCE.indexOf("func axAttribute("));
  const guards = MACOS_CAPTURE_SOURCE.slice(0, MACOS_CAPTURE_SOURCE.indexOf("final class CaptureValue"));
  const output = execFileSync("/usr/bin/swift", ["-"], {
    input: `import Foundation\nimport CoreGraphics\n${rectJSON}\n${readRect}\n${guards}\n` + String.raw`
struct NativeFailure: Error { let code:String; init(_ code:String) { self.code=code } }
func requireDesktopSourceBinding(_ binding:String?) throws -> Bool {
  guard binding == "fixture" else { throw NativeFailure("computer_desktop_stale") }
  return true
}
func failure(_ operation:() throws -> Void) -> String {
  do { try operation(); return "ok" }
  catch let error as NativeFailure { return error.code }
  catch { return "unexpected" }
}
let bounds=CGRect(x:-1440.5,y:40.25,width:2880.5,height:1800.25)
let state:[String:Any]=["desktop":["binding":"fixture","bounds":rectJSON(bounds)]]
let request:[String:Any]=["region":rectJSON(bounds),"expectedGeometry":rectJSON(bounds),"desktopBinding":"fixture"]
let serialized=try JSONSerialization.data(withJSONObject:rectJSON(bounds))
let decoded=try JSONSerialization.jsonObject(with:serialized)
let zero:[String:Double]=["x":0,"y":0,"width":0,"height":1]
let infinite:[String:Double]=["x":Double.infinity,"y":0,"width":1,"height":1]
let changed=CGRect(x:bounds.minX,y:bounds.minY,width:bounds.width-1,height:bounds.height)
let stale:[String:Any]=["desktop":["binding":"stale","bounds":rectJSON(bounds)]]
let result:[String:Any]=[
  "direct":readRect(rectJSON(bounds))==bounds,
  "serialized":readRect(decoded)==bounds,
  "invalid":readRect(zero)==nil && readRect(infinite)==nil && readRect(["x":1])==nil,
  "capture":failure { try requireCaptureSourceGeometry(state,bounds) },
  "observation":failure { try requireObservationSource(request,state) },
  "changed":failure { try requireCaptureSourceGeometry(state,changed) },
  "stale":failure { try requireCaptureSourceGeometry(stale,bounds) }
]
print(String(data:try JSONSerialization.data(withJSONObject:result),encoding:.utf8)!)
`, encoding: "utf8", timeout: 60_000,
  });
  expect(JSON.parse(output)).toEqual({ direct: true, serialized: true, invalid: true,
    capture: "ok", observation: "ok", changed: "computer_geometry_changed", stale: "computer_desktop_stale" });
}, 65_000);

test.skipIf(process.platform !== "darwin")("the complete native computer helper typechecks without requesting permissions or capturing", () => {
  execFileSync("/usr/bin/swiftc", ["-typecheck", "-"], { input: MACOS_COMPUTER_HELPER, encoding: "utf8", timeout: 60_000 });
}, 65_000);
