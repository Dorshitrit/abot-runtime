export const MACOS_DESKTOP_SOURCE = String.raw`
import Foundation
import AppKit
import ApplicationServices
import ScreenCaptureKit
import ImageIO
import Darwin
struct NativeFailure: Error {
  let code: String
  init(_ code: String) {
    self.code=code
  }
}
let outputLock=NSLock()
func emit(_ value: [String:Any]) {
  guard let data=try? JSONSerialization.data(withJSONObject:value), let text=String(data:data,encoding:.utf8) else {
    return
  }
  outputLock.lock()
  print(text)
  fflush(stdout)
  outputLock.unlock()
}
func capability(_ available: Bool,_ reason: String = "",supported: Bool = true) -> [String:Any] {
  var result:[String:Any] = ["supported":supported,"available":available]
  if !available && !reason.isEmpty {
    result["reason"]=reason
  }
  return result
}
func rectJSON(_ rect: CGRect) -> [String:Any] {
  return ["x":rect.minX,"y":rect.minY,"width":rect.width,"height":rect.height]
}
func boundedText(_ value:String,_ limit:Int=256) -> String {
  var result="",length=0
  for scalar in value.unicodeScalars {
    let text=String(scalar)
    if length+text.utf8.count>limit { break }
    result+=text
    length+=text.utf8.count
  }
  return result
}
func readRect(_ value: Any?) -> CGRect? {
  guard let value=value as? [String:Double], let x=value["x"],let y=value["y"],let w=value["width"],let h=value["height"], [x,y,w,h].allSatisfy({
    $0.isFinite
  }
  ), w>0,h>0 else {
    return nil
  }
  return CGRect(x:x,y:y,width:w,height:h)
}
func axAttribute(_ element: AXUIElement,_ name: String) -> CFTypeRef? {
  var value:CFTypeRef?
  return AXUIElementCopyAttributeValue(element,name as CFString,&value) == .success ? value : nil
}
func axElement(_ value: CFTypeRef?) -> AXUIElement? {
  guard let value=value,CFGetTypeID(value)==AXUIElementGetTypeID() else {
    return nil
  }
  return unsafeBitCast(value,to:AXUIElement.self)
}
func axBounds(_ element: AXUIElement) -> CGRect? {
  guard let position=axAttribute(element,kAXPositionAttribute),CFGetTypeID(position)==AXValueGetTypeID(),let size=axAttribute(element,kAXSizeAttribute),CFGetTypeID(size)==AXValueGetTypeID() else {
    return nil
  }
  var point=CGPoint.zero,dimensions=CGSize.zero
  guard AXValueGetValue(unsafeBitCast(position,to:AXValue.self),.cgPoint,&point),AXValueGetValue(unsafeBitCast(size,to:AXValue.self),.cgSize,&dimensions),dimensions.width>0,dimensions.height>0 else {
    return nil
  }
  return CGRect(origin:point,size:dimensions)
}
struct WindowReference {
  let element:AXUIElement
  let pid:pid_t
  let binding:String
}
var windowReferences=[WindowReference]()
let desktopSessionBinding="macos:"+String(getuid())+":"+UUID().uuidString
func displayBounds() -> CGRect {
  return readDisplaySource()?.bounds ?? CGRect(x:0,y:0,width:1,height:1)
}
func sessionAvailable() -> Bool {
  guard let session=CGSessionCopyCurrentDictionary() as? [String:Any] else {
    return false
  }
  if session["CGSSessionScreenIsLocked"] as? Bool == true {
    return false
  }
  return session[kCGSessionOnConsoleKey as String] as? Bool == true
}
func hasScreenCapture() -> Bool {
  guard #available(macOS 14.0,*) else {
    return false
  }
  return CGPreflightScreenCaptureAccess()
}
func targetingGuaranteeForFocus(_ focused:String?) -> String {
  guard let focused=focused,!focused.isEmpty else { return "observed_surface" }
  return "verified_window"
}
func desktopState() -> [String:Any] {
  let source=readDisplaySource()
  let available=sessionAvailable() && source != nil,accessible=AXIsProcessTrusted()
  let bounds=source?.bounds ?? CGRect(x:0,y:0,width:1,height:1)
  var current=[WindowReference](),windows=[[String:Any]](),focused:String?
  if available && accessible {
    let foreground=NSWorkspace.shared.frontmostApplication?.processIdentifier
    for app in NSWorkspace.shared.runningApplications where !app.isTerminated {
      if windows.count>=64 {
        break
      }
      let root=AXUIElementCreateApplication(app.processIdentifier)
      let active=axElement(axAttribute(root,kAXFocusedWindowAttribute))
      for item in (axAttribute(root,kAXWindowsAttribute) as? [AXUIElement] ?? []).prefix(64-windows.count) {
        guard let frame=axBounds(item) else {
          continue
        }
        let old=windowReferences.first {
          $0.pid==app.processIdentifier && CFEqual($0.element,item)
        }
        let reference=WindowReference(element:item,pid:app.processIdentifier,binding:old?.binding ?? UUID().uuidString)
        current.append(reference)
        let isFocused=foreground==app.processIdentifier && active.map {
          CFEqual($0,item)
        }
        == true
        let title=boundedText(axAttribute(item,kAXTitleAttribute) as? String ?? "",128)
        windows.append(["binding":reference.binding,"title":title,"application":boundedText(app.bundleIdentifier ?? app.localizedName ?? "",128),"bounds":rectJSON(frame),"focused":isFocused])
        if isFocused {
          focused=reference.binding
        }
      }
    }
  }
  windowReferences=current
  let permissions:[String:Any] = ["capture":capability(available && hasScreenCapture(),"macos_screen_recording_permission_or_macos14_required"),"input":capability(available && accessible,"macos_accessibility_permission_required"),"accessibility":capability(available && accessible,"macos_accessibility_permission_required"),"windows":capability(available && accessible,"macos_accessibility_permission_required")]
  var desktop:[String:Any] = ["platform":"macos","binding":source?.binding ?? desktopSessionBinding+":unavailable","name":"Mac user desktop","available":available,"bounds":rectJSON(bounds),"capabilities":permissions,"targetingGuarantee":targetingGuaranteeForFocus(focused),"coordinateSpace":"logical_points"]
  if !available {
    desktop["reason"]="macos_session_locked_or_unavailable"
  }
  if source == nil { desktop["reason"]="macos_topology_unavailable" }
  var state:[String:Any] = ["desktop":desktop,"windows":windows]
  if let focused=focused {
    state["focusedWindow"]=focused
  }
  return state
}
func accessibilitySnapshot(_ binding:String?) -> ([[String:Any]],Bool) {
  guard let binding=binding,let root=windowReferences.first(where:{
    $0.binding==binding
  }
  )?.element else {
    return ([],false)
  }
  var pending=[root],nodes=[[String:Any]](),visited=0,length=0
  let deadline=Date().addingTimeInterval(0.4)
  while !pending.isEmpty && nodes.count<64 && visited<400 && length<24000 && Date()<deadline {
    let item=pending.removeFirst()
    visited+=1
    if axAttribute(item,kAXSubroleAttribute) as? String == "AXSecureTextField" {
      continue
    }
    if axAttribute(item,"AXHidden") as? Bool == true {
      continue
    }
    let role=axAttribute(item,kAXRoleAttribute) as? String ?? "unknown"
    let children=axAttribute(item,kAXChildrenAttribute) as? [AXUIElement] ?? []
    var node:[String:Any] = ["role":boundedText(role,64),"name":boundedText(axAttribute(item,kAXTitleAttribute) as? String ?? axAttribute(item,kAXDescriptionAttribute) as? String ?? "",128)]
    if children.isEmpty,let value=axAttribute(item,kAXValueAttribute) as? String {
      node["value"]=boundedText(value)
    }
    if let frame=axBounds(item) {
      node["bounds"]=rectJSON(frame)
    }
    if let isFocused=axAttribute(item,kAXFocusedAttribute) as? Bool {
      node["focused"]=isFocused
    }
    length+=(node["name"] as? String ?? "").count+(node["value"] as? String ?? "").count
    nodes.append(node)
    pending.append(contentsOf:children.prefix(max(0,400-pending.count)))
  }
  return (nodes,!pending.isEmpty)
}
`;
