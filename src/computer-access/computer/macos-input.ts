export const MACOS_INPUT_SOURCE = String.raw`
func incompleteDispatchError(_ dispatch:[String:Any]) -> [String:Any]? {
  if dispatch["status"] as? String == "partial" {
    return ["code":"computer_input_partial","message":"Native input was only partially dispatched. Inspect the receipt and fresh observation before another action."]
  }
  if dispatch["status"] as? String == "unknown" {
    return ["code":"computer_input_unknown","message":"Native input dispatch is uncertain. Inspect the receipt and fresh observation before another action."]
  }
  return nil
}
final class CancellationFlag {
  let lock=NSLock()
  var cancelled=false
  func cancel() {
    lock.lock()
    cancelled=true
    lock.unlock()
  }
  func check(_ deadline:Double) throws {
    lock.lock()
    let stopped=cancelled
    lock.unlock()
    if stopped {
      throw NativeFailure("computer_action_cancelled")
    }
    if Date().timeIntervalSince1970*1000>deadline {
      throw NativeFailure("computer_action_deadline")
    }
  }
}
let keyCodes:[String:CGKeyCode] = ["a":0,"s":1,"d":2,"f":3,"h":4,"g":5,"z":6,"x":7,"c":8,"v":9,"b":11,"q":12,"w":13,"e":14,"r":15,"y":16,"t":17,"1":18,"2":19,"3":20,"4":21,"6":22,"5":23,"=":24,"9":25,"7":26,"-":27,"8":28,"0":29,"]":30,"o":31,"u":32,"[":33,"i":34,"p":35,"l":37,"j":38,"'":39,"k":40,";":41,"\\":42,",":43,"/":44,"n":45,"m":46,".":47,"\u{60}":50,"Enter":36,"Return":36,"Tab":48,"Space":49,"Backspace":51,"Delete":117,"Esc":53,"Escape":53,"Meta":55,"Super":55,"Command":55,"Shift":56,"Alt":58,"Option":58,"Ctrl":59,"Control":59,"F1":122,"F2":120,"F3":99,"F4":118,"F5":96,"F6":97,"F7":98,"F8":100,"F9":101,"F10":109,"F11":103,"F12":111,"Home":115,"End":119,"PageUp":116,"PageDown":121,"ArrowLeft":123,"ArrowRight":124,"ArrowDown":125,"ArrowUp":126]
func nativeKey(_ value:String) throws -> CGKeyCode {
  if let key=keyCodes[value] {
    return key
  }
  if value.count==1,let key=keyCodes[value.lowercased()] {
    return key
  }
  throw NativeFailure("macos_key_unsupported")
}
func modifierFlag(_ key:CGKeyCode) -> CGEventFlags {
  switch key {
    case 55:return .maskCommand
    case 56:return .maskShift
    case 58:return .maskAlternate
    case 59:return .maskControl
    default:return []
  }
}
func actionCount(_ action:[String:Any]) -> Int {
  switch action["kind"] as? String {
    case "type_text":return ((action["text"] as? String)?.unicodeScalars.count ?? 0)*2
    case "press_keys":return ((action["keys"] as? [String])?.count ?? 0)*2
    case "click":return 1+(action["count"] as? Int ?? 1)*2
    case "drag":return 15
    default:return 1
  }
}
func readPoint(_ value:Any?) throws -> CGPoint {
  guard let value=value as? [String:Double],let x=value["x"],let y=value["y"],x.isFinite,y.isFinite else {
    throw NativeFailure("computer_point_invalid")
  }
  return CGPoint(x:x,y:y)
}
func validateAction(_ action:[String:Any],_ state:[String:Any]) throws {
  guard let kind=action["kind"] as? String,["click","move","drag","scroll","type_text","press_keys","focus_window"].contains(kind) else {
    throw NativeFailure("computer_action_unsupported")
  }
  let bounds=displayBounds()
  let names=kind=="drag" ? ["from","to"] : ["click","move"].contains(kind) ? ["point"] : []
  for name in names {
    if !bounds.contains(try readPoint(action[name])) {
      throw NativeFailure("computer_point_outside_desktop")
    }
  }
  if ["click","drag"].contains(kind),!["left","middle","right"].contains(action["button"] as? String ?? "") {
    throw NativeFailure("computer_button_invalid")
  }
  if kind=="click",![1,2].contains(action["count"] as? Int ?? 0) {
    throw NativeFailure("computer_click_count_invalid")
  }
  if kind=="drag",!(0...5000).contains(action["durationMs"] as? Int ?? -1) {
    throw NativeFailure("computer_drag_duration_invalid")
  }
  if kind=="scroll" {
    guard let x=action["deltaX"] as? Double,let y=action["deltaY"] as? Double,x.isFinite,y.isFinite,abs(x)<=12000,abs(y)<=12000 else {
      throw NativeFailure("computer_scroll_invalid")
    }
    guard x.truncatingRemainder(dividingBy:120)==0,y.truncatingRemainder(dividingBy:120)==0 else {
      throw NativeFailure("macos_scroll_fraction_unsupported")
    }
  }
  if kind=="type_text" {
    guard let text=action["text"] as? String,text.utf16.count<=10000 else {
      throw NativeFailure("computer_text_limit")
    }
  }
  if kind=="press_keys" {
    guard let keys=action["keys"] as? [String],!keys.isEmpty,keys.count<=8 else {
      throw NativeFailure("computer_keys_invalid")
    }
    for key in keys {
      _ = try nativeKey(key)
    }
  }
  if kind=="focus_window",!windowReferences.contains(where:{
    $0.binding==action["windowBinding"] as? String
  }
  ) {
    throw NativeFailure("computer_window_stale")
  }
}
func requireVerifiedTextFocus(_ action:[String:Any],_ expectedWindow:String?) throws {
  guard action["kind"] as? String == "type_text" else { return }
  guard let expectedWindow=expectedWindow else { return }
  guard let reference=windowReferences.first(where: { $0.binding==expectedWindow }) else {
    throw NativeFailure("computer_focus_changed")
  }
  guard NSWorkspace.shared.frontmostApplication?.processIdentifier==reference.pid else {
    throw NativeFailure("computer_focus_changed")
  }
  let root=AXUIElementCreateApplication(reference.pid)
  guard let focused=axElement(axAttribute(root,kAXFocusedWindowAttribute)),CFEqual(focused,reference.element) else {
    throw NativeFailure("computer_focus_changed")
  }
}
func executeInput(_ id:String,_ action:[String:Any],_ cancel:CancellationFlag,_ deadline:Double,_ expectedWindow:String? = nil) throws -> [String:Any] {
  try cancel.check(deadline)
  guard let source=CGEventSource(stateID:.privateState) else {
    throw NativeFailure("macos_input_source_unavailable")
  }
  let requested=actionCount(action)
  var accepted=0,heldKeys=[CGKeyCode](),heldButton:CGMouseButton?,flags=CGEventFlags()
  var lastPoint=CGEvent(source:nil)?.location ?? .zero
  func post(_ event:CGEvent?) throws {
    try cancel.check(deadline)
    try requireVerifiedTextFocus(action,expectedWindow)
    guard let event=event else {
      throw NativeFailure("macos_input_event_unavailable")
    }
    event.flags=flags
    event.post(tap:.cghidEventTap)
    accepted+=1
  }
  func keyboard(_ key:CGKeyCode,_ down:Bool) throws {
    let flag=modifierFlag(key)
    if down {
      flags.formUnion(flag)
    }
    else {
      flags.subtract(flag)
    }
    try post(CGEvent(keyboardEventSource:source,virtualKey:key,keyDown:down))
    if down {
      heldKeys.append(key)
    }
    else {
      heldKeys.removeAll {
        $0==key
      }
    }
  }
  func mouse(_ type:CGEventType,_ point:CGPoint,_ button:CGMouseButton,_ click:Int=1) throws {
    let event=CGEvent(mouseEventSource:source,mouseType:type,mouseCursorPosition:point,mouseButton:button)
    event?.setIntegerValueField(.mouseEventClickState,value:Int64(click))
    try post(event)
    lastPoint=point
  }
  emit(["type":"dispatch","id":id,"dispatch":["status":"unknown","requestedInputCount":requested,"reason":"native_dispatch_started"]])
  var failure:String?
  do {
    let kind=action["kind"] as! String
    if kind=="move" {
      try mouse(.mouseMoved,try readPoint(action["point"]),.left)
    }
    if kind=="click" || kind=="drag" {
      let button:CGMouseButton = action["button"] as? String == "right" ? .right : action["button"] as? String == "middle" ? .center : .left
      let down:CGEventType = button == .left ? .leftMouseDown : button == .right ? .rightMouseDown : .otherMouseDown
      let up:CGEventType = button == .left ? .leftMouseUp : button == .right ? .rightMouseUp : .otherMouseUp
      let start=try readPoint(action[kind=="click" ? "point":"from"])
      try mouse(.mouseMoved,start,button)
      if kind=="click" {
        for number in 1...(action["count"] as! Int) {
          try mouse(down,start,button,number)
          heldButton=button
          try mouse(up,start,button,number)
          heldButton=nil
          if number==1 && action["count"] as! Int==2 {
            Thread.sleep(forTimeInterval:0.05)
          }
        }
      }
      else {
        let end=try readPoint(action["to"])
        try mouse(down,start,button)
        heldButton=button
        let dragged:CGEventType = button == .left ? .leftMouseDragged : button == .right ? .rightMouseDragged : .otherMouseDragged
        for step in 1...12 {
          let ratio=Double(step)/12
          try mouse(dragged,CGPoint(x:start.x+(end.x-start.x)*ratio,y:start.y+(end.y-start.y)*ratio),button)
          Thread.sleep(forTimeInterval:Double(action["durationMs"] as! Int)/12000)
        }
        try mouse(up,end,button)
        heldButton=nil
      }
    }
    if kind=="scroll" {
      let x=Int32((action["deltaX"] as! Double)/120),y=Int32((action["deltaY"] as! Double)/120)
      try post(CGEvent(scrollWheelEvent2Source:source,units:.line,wheelCount:2,wheel1:-y,wheel2:-x,wheel3:0))
    }
    if kind=="press_keys" {
      let keys=try (action["keys"] as! [String]).map {
        try nativeKey($0)
      }
      for key in keys {
        try keyboard(key,true)
      }
      for key in keys.reversed() {
        try keyboard(key,false)
      }
    }
    if kind=="type_text" {
      for scalar in (action["text"] as! String).unicodeScalars {
        var units=Array(String(scalar).utf16)
        for down in [true,false] {
          let event=CGEvent(keyboardEventSource:source,virtualKey:0,keyDown:down)
          event?.keyboardSetUnicodeString(stringLength:units.count,unicodeString:&units)
          try post(event)
          if down { heldKeys.append(0) } else { heldKeys.removeAll { $0 == 0 } }
        }
      }
    }
    if kind=="focus_window" {
      try cancel.check(deadline)
      guard let reference=windowReferences.first(where:{
        $0.binding==action["windowBinding"] as? String
      }
      ),let app=NSRunningApplication(processIdentifier:reference.pid) else {
        throw NativeFailure("computer_window_stale")
      }
      guard app.activate(options:[.activateIgnoringOtherApps]),AXUIElementPerformAction(reference.element,kAXRaiseAction as CFString) == .success else {
        throw NativeFailure("macos_window_focus_failed")
      }
      accepted+=1
    }
  }
  catch {
    failure=(error as? NativeFailure)?.code ?? "macos_native_input_failed"
  }
  // Release only this operation's own held input, even after cooperative cancellation.
  for key in heldKeys.reversed() {
    flags.subtract(modifierFlag(key))
    let event=CGEvent(keyboardEventSource:source,virtualKey:key,keyDown:false)
    event?.flags=flags
    event?.post(tap:.cghidEventTap)
  }
  if let button=heldButton {
    let type:CGEventType = button == .left ? .leftMouseUp : button == .right ? .rightMouseUp : .otherMouseUp
    CGEvent(mouseEventSource:source,mouseType:type,mouseCursorPosition:lastPoint,mouseButton:button)?.post(tap:.cghidEventTap)
  }
  var dispatch:[String:Any] = ["status":failure==nil ? "accepted":accepted>0 ? "partial":"unknown","requestedInputCount":requested,"acceptedInputCount":accepted]
  if let failure=failure {
    dispatch["reason"]=failure
  }
  return dispatch
}
`;
