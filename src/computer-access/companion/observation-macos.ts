/** Swift/AppKit event helper. Missing developer tools or Accessibility grant is reported explicitly. */
import { OBSERVATION_CAPTURE_POLICY as policy } from "./observation-capture-policy.js";
import { MACOS_OBSERVATION_PERMISSION_SCRIPT } from "./observation-macos-permission.js";
export const MACOS_OBSERVATION_SCRIPT = String.raw`
import AppKit
import ApplicationServices
func emit(_ value: [String: Any]) {
  if let data = try? JSONSerialization.data(withJSONObject: value), let text = String(data: data, encoding: .utf8) {
    print(text); fflush(stdout)
  }
}
func status(_ state: String, _ reason: String) { emit(["type":"status","state":state,"reason":reason]) }
${MACOS_OBSERVATION_PERMISSION_SCRIPT}
guard waitForMacObservationPermission(
  isTrusted: { AXIsProcessTrusted() },
  requestPermission: {
    let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
    _ = AXIsProcessTrustedWithOptions(options)
  },
  now: { ProcessInfo.processInfo.systemUptime },
  wait: { Thread.sleep(forTimeInterval: $0) },
  reportRequired: { status("permission_required","macos_accessibility_permission_required") },
  reportTimeout: { status("permission_required","macos_accessibility_permission_timeout") }
) else { exit(0) }
let exclusions = Set(((ProcessInfo.processInfo.environment["ABOT_OBSERVATION_EXCLUSIONS"] ?? "[]").data(using:.utf8).flatMap { try? JSONSerialization.jsonObject(with:$0) as? [String] } ?? []).map { $0.lowercased() })
func attr(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
  var value: CFTypeRef?
  return AXUIElementCopyAttributeValue(element,name as CFString,&value) == .success ? value : nil
}
func window(_ app: NSRunningApplication) -> AXUIElement? {
  let root = AXUIElementCreateApplication(app.processIdentifier)
  guard let value = attr(root,kAXFocusedWindowAttribute) else { return nil }
  guard CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
  return unsafeBitCast(value,to:AXUIElement.self)
}
func document(_ app: NSRunningApplication, _ root: AXUIElement) -> AXUIElement? {
  guard let value=attr(AXUIElementCreateApplication(app.processIdentifier),kAXFocusedUIElementAttribute), CFGetTypeID(value)==AXUIElementGetTypeID() else { return nil }
  var item=unsafeBitCast(value,to:AXUIElement.self)
  var found: AXUIElement?
  for _ in 0..<32 {
    if CFEqual(item,root) { return found }
    if found == nil, ["AXWebArea","AXDocument"].contains(attr(item,kAXRoleAttribute) as? String ?? "") { found=item }
    guard let parent=attr(item,kAXParentAttribute), CFGetTypeID(parent)==AXUIElementGetTypeID() else { return nil }
    item=unsafeBitCast(parent,to:AXUIElement.self)
  }
  return nil
}
func bounds(_ element: AXUIElement) -> CGRect? {
  guard let position=attr(element,kAXPositionAttribute), CFGetTypeID(position)==AXValueGetTypeID(), let size=attr(element,kAXSizeAttribute), CFGetTypeID(size)==AXValueGetTypeID() else { return nil }
  var point=CGPoint.zero, dimensions=CGSize.zero
  guard AXValueGetValue(unsafeBitCast(position,to:AXValue.self),.cgPoint,&point), AXValueGetValue(unsafeBitCast(size,to:AXValue.self),.cgSize,&dimensions), dimensions.width>0, dimensions.height>0 else { return nil }
  return CGRect(origin:point,size:dimensions)
}
func key(_ app: NSRunningApplication, _ window: AXUIElement) -> String {
  let documentId=document(app,window).map { String(CFHash($0)) } ?? ""
  return "\(app.processIdentifier):\(CFHash(window)):\(attr(window,kAXTitleAttribute) as? String ?? ""):\(attr(window,kAXDocumentAttribute) as? String ?? ""):\(documentId)"
}
var quiet: Timer?
var maximum: Timer?
var lastCapture = -Double(${policy.minimumIntervalMs}) / 1000
var burstStarted = 0.0
var burstCaptures = 0
var noisePaused = false
var edited = false
var editKey: String?
var observer: AXObserver?
var observedPid: pid_t = 0
var watchedElements=[AXUIElement]()
var sessionActive = true
func locked() -> Bool {
  guard sessionActive else { return true }
  guard let session = CGSessionCopyCurrentDictionary() as? [String: Any] else { return true }
  if session["CGSSessionScreenIsLocked"] as? Bool == true { return true }
  return session[kCGSessionOnConsoleKey as String] as? Bool != true
}
func changed(_ edit: Bool, switched: Bool = false) {
  if edit || switched { noisePaused=false; burstCaptures=0; burstStarted=ProcessInfo.processInfo.systemUptime }
  edited = edited || edit
  if edit, let app=NSWorkspace.shared.frontmostApplication, let root=window(app) { editKey=key(app,root) }
  quiet?.invalidate()
  quiet = Timer.scheduledTimer(withTimeInterval:noisePaused ? ${policy.resumeQuietMs / 1000} : 1.2,repeats:false) { _ in capture() }
  if !noisePaused && maximum == nil { maximum = Timer.scheduledTimer(withTimeInterval:5,repeats:false) { _ in capture() } }
}
let callback: AXObserverCallback = { _, element, notification, _ in
  var pid: pid_t=0
  guard AXUIElementGetPid(element,&pid) == .success, pid == NSWorkspace.shared.frontmostApplication?.processIdentifier else { return }
  let switched = notification as String == kAXFocusedWindowChangedNotification
  if switched { changed(false,switched:true); return }
  let valueChanged = notification as String == kAXValueChangedNotification
  if noisePaused && !valueChanged { changed(false); return }
  let role = attr(element,kAXRoleAttribute) as? String ?? ""
  let editable = [kAXTextFieldRole,kAXTextAreaRole].contains(role) && attr(element,kAXSubroleAttribute) as? String != "AXSecureTextField"
  if noisePaused && !editable { changed(false); return }
  guard let app=NSWorkspace.shared.frontmostApplication, let currentWindow=window(app) else { return }
  var ancestor: AXUIElement?=element
  var belongs=false
  for _ in 0..<32 {
    guard let current=ancestor else { break }
    if CFEqual(current,currentWindow) { belongs=true; break }
    guard let parent=attr(current,kAXParentAttribute), CFGetTypeID(parent)==AXUIElementGetTypeID() else { break }
    ancestor=unsafeBitCast(parent,to:AXUIElement.self)
  }
  if !belongs { changed(false); return }
  changed(valueChanged && editable)
}
func bind(_ app: NSRunningApplication) {
  if observedPid == app.processIdentifier { return }
  if let old = observer { CFRunLoopRemoveSource(CFRunLoopGetCurrent(),AXObserverGetRunLoopSource(old),.defaultMode) }
  observer = nil; observedPid = app.processIdentifier
  watchedElements=[]
  guard AXObserverCreate(observedPid,callback,&observer) == .success, let current = observer else { return }
  let root = AXUIElementCreateApplication(observedPid)
  for event in [kAXFocusedWindowChangedNotification,kAXFocusedUIElementChangedNotification,kAXTitleChangedNotification,kAXValueChangedNotification,kAXSelectedTextChangedNotification,kAXUIElementDestroyedNotification] {
    AXObserverAddNotification(current,root,event as CFString,nil)
  }
  CFRunLoopAddSource(CFRunLoopGetCurrent(),AXObserverGetRunLoopSource(current),.defaultMode)
}
func capture() {
  guard AXIsProcessTrusted() else { status("permission_required","macos_accessibility_permission_revoked"); exit(0) }
  quiet?.invalidate(); maximum?.invalidate(); quiet=nil; maximum=nil
  let now=ProcessInfo.processInfo.systemUptime
  if noisePaused { noisePaused=false; burstCaptures=0 }
  if now-lastCapture < ${policy.minimumIntervalMs / 1000} {
    quiet=Timer.scheduledTimer(withTimeInterval:${policy.minimumIntervalMs / 1000}-(now-lastCapture),repeats:false) { _ in capture() }; return
  }
  if now-burstStarted > ${policy.burstWindowMs / 1000} { burstStarted=now; burstCaptures=0 }
  if !edited { burstCaptures += 1 }
  if burstCaptures > ${policy.burstLimit} {
    noisePaused=true; status("paused","continuous_activity")
    quiet=Timer.scheduledTimer(withTimeInterval:${policy.resumeQuietMs / 1000},repeats:false) { _ in capture() }; return
  }
  lastCapture=now
  let wasEdited=edited; edited=false
  if locked() { status("paused","screen_locked_or_inactive_session"); return }
  guard let app=NSWorkspace.shared.frontmostApplication else { return }
  let appName=app.bundleIdentifier ?? app.localizedName ?? "unknown"
  if exclusions.contains(appName.lowercased()) || exclusions.contains((app.localizedName ?? "").lowercased()) { status("paused","application_excluded"); return }
  if appName == "com.apple.loginwindow" { status("paused","screen_locked_or_inactive_session"); return }
  bind(app)
  guard let root=window(app) else { status("partial","focused_window_unavailable"); return }
  let before=key(app,root)
  let kind = wasEdited && editKey == before ? "edit" : "view"
  let contentRoot=document(app,root)
  let windowBounds=bounds(root)
  var queue=[contentRoot ?? root], parts=[String](), seen=Set<String>(), count=0, length=0
  let start=Date()
  if let current=observer {
    for item in watchedElements {
      AXObserverRemoveNotification(current,item,kAXValueChangedNotification as CFString)
      AXObserverRemoveNotification(current,item,kAXTitleChangedNotification as CFString)
    }
  }
  watchedElements=[]
  while !queue.isEmpty && count<600 && length<24000 && Date().timeIntervalSince(start)<0.4 {
    let item=queue.removeFirst(); count += 1
    if attr(item,kAXSubroleAttribute) as? String == "AXSecureTextField" { continue }
    if attr(item,"AXHidden") as? Bool == true { continue }
    if contentRoot == nil, ["AXWebArea","AXDocument"].contains(attr(item,kAXRoleAttribute) as? String ?? "") { continue }
    if let current=observer {
      AXObserverAddNotification(current,item,kAXValueChangedNotification as CFString,nil)
      AXObserverAddNotification(current,item,kAXTitleChangedNotification as CFString,nil)
      watchedElements.append(item)
    }
    let children=attr(item,kAXChildrenAttribute) as? [AXUIElement] ?? []
    if children.isEmpty, let visible=bounds(item), let frame=windowBounds, visible.intersects(frame) {
      let role=attr(item,kAXRoleAttribute) as? String ?? ""
      if [kAXStaticTextRole,kAXTextFieldRole,kAXTextAreaRole].contains(role), let text=attr(item,kAXValueAttribute) as? String, !text.isEmpty, seen.insert(text).inserted {
        parts.append(text); length += text.count
      }
    }
    queue.append(contentsOf:children.prefix(max(0,600-queue.count)))
  }
  guard !locked(), let afterApp=NSWorkspace.shared.frontmostApplication, afterApp.processIdentifier == app.processIdentifier, let afterWindow=window(afterApp), key(afterApp,afterWindow)==before else { return }
  var source:[String:Any] = ["app":appName,"processId":Int(app.processIdentifier),"windowId":String(CFHash(root)),"title":attr(root,kAXTitleAttribute) as? String ?? ""]
  if let contentRoot=contentRoot { source["documentId"]=String(CFHash(contentRoot)) }
  else if let document=attr(root,kAXDocumentAttribute) as? String { source["documentId"]=document }
  let content=String(parts.joined(separator:"\n").prefix(24000))
  emit(["type":"snapshot","source":source,"content":content,"kind":kind,"extraction":"ax","coverage":content.isEmpty ? "metadata_only":"partial","coverageReason":"visible_accessibility_subset","beforeKey":before,"afterKey":before])
  status("partial","ax_application_coverage")
}
let center=NSWorkspace.shared.notificationCenter
center.addObserver(forName:NSWorkspace.didActivateApplicationNotification,object:nil,queue:.main) { _ in changed(false,switched:true) }
center.addObserver(forName:NSWorkspace.sessionDidResignActiveNotification,object:nil,queue:.main) { _ in sessionActive=false; changed(false) }
center.addObserver(forName:NSWorkspace.sessionDidBecomeActiveNotification,object:nil,queue:.main) { _ in sessionActive=true; changed(false) }
DistributedNotificationCenter.default().addObserver(forName:NSNotification.Name("com.apple.screenIsLocked"),object:nil,queue:.main) { _ in sessionActive=false; changed(false) }
DistributedNotificationCenter.default().addObserver(forName:NSNotification.Name("com.apple.screenIsUnlocked"),object:nil,queue:.main) { _ in sessionActive=true; changed(false) }
status("partial","ax_application_coverage"); changed(false)
RunLoop.main.run()
`;
