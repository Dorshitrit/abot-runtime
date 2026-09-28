/** Quartz capture source identity includes individual display layout and pixel scale. */
export const MACOS_TOPOLOGY_SOURCE = String.raw`
import CryptoKit
struct DisplaySourceSnapshot {
  let binding:String
  let bounds:CGRect
  let displays:[CGDirectDisplayID]
}
func readDisplaySource() -> DisplaySourceSnapshot? {
  var count:UInt32=0
  guard CGGetActiveDisplayList(0,nil,&count) == .success,count>0,count<=128 else { return nil }
  var displays=[CGDirectDisplayID](repeating:0,count:Int(count))
  guard CGGetActiveDisplayList(count,&displays,&count) == .success else { return nil }
  let identifiers=Array(displays.prefix(Int(count))).sorted()
  var records=[[String:Any]](),bounds=CGRect.null
  for identifier in identifiers {
    let frame=CGDisplayBounds(identifier)
    guard !frame.isEmpty,let mode=CGDisplayCopyDisplayMode(identifier) else { return nil }
    bounds=bounds.union(frame)
    records.append(["id":identifier,"rect":rectJSON(frame),"rotation":CGDisplayRotation(identifier),
      "mode":mode.ioDisplayModeID,"width":mode.width,"height":mode.height,
      "pixelWidth":mode.pixelWidth,"pixelHeight":mode.pixelHeight,
      "mirrors":CGDisplayMirrorsDisplay(identifier),"main":CGDisplayIsMain(identifier)])
  }
  guard let data=try? JSONSerialization.data(withJSONObject:records,options:[.sortedKeys]) else { return nil }
  let fingerprint=SHA256.hash(data:data).map { String(format:"%02x",$0) }.joined()
  return DisplaySourceSnapshot(binding:desktopSessionBinding+":"+fingerprint,bounds:bounds,displays:identifiers)
}
func requireDesktopSourceBinding(_ expected:String?) throws -> DisplaySourceSnapshot {
  guard let source=readDisplaySource() else { throw NativeFailure("macos_topology_unavailable") }
  guard expected==source.binding else { throw NativeFailure("computer_desktop_stale") }
  return source
}
`;
