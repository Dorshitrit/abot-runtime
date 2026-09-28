import { MACOS_DESKTOP_SOURCE } from "./macos-desktop.js";
import { MACOS_CAPTURE_SOURCE } from "./macos-capture.js";
import { MACOS_INPUT_SOURCE } from "./macos-input.js";
import { MACOS_TOPOLOGY_SOURCE } from "./macos-topology.js";

const MACOS_COMMAND_LOOP = String.raw`
func perform(_ id:String,_ request:[String:Any],_ cancel:CancellationFlag) -> [String:Any] {
  var state=desktopState(),dispatch:[String:Any]?
  do {
    let operation=request["operation"] as? String
    if operation=="inspect" {
      return state
    }
    if operation=="observe" {
      try requireObservationSource(request,state)
      return try addCapture(state,request["region"])
    }
    guard operation=="act",let action=request["action"] as? [String:Any],let deadline=request["deadlineEpochMs"] as? Double else {
      throw NativeFailure("computer_request_invalid")
    }
    try cancel.check(deadline)
    guard sessionAvailable() else {
      throw NativeFailure("macos_session_locked_or_unavailable")
    }
    guard AXIsProcessTrusted() else {
      throw NativeFailure("macos_accessibility_permission_required")
    }
    _ = try requireDesktopSourceBinding(request["desktopBinding"] as? String)
    guard let geometry=readRect(request["expectedGeometry"]),geometry==displayBounds() else {
      throw NativeFailure("computer_geometry_changed")
    }
    if let expected=request["expectedWindow"] as? String,expected != state["focusedWindow"] as? String {
      throw NativeFailure("computer_focus_changed")
    }
    try validateAction(action,state)
    _ = try requireDesktopSourceBinding(request["desktopBinding"] as? String)
    dispatch=try executeInput(id,action,cancel,deadline,request["expectedWindow"] as? String)
    emit(["type":"dispatch","id":id,"dispatch":dispatch!])
    state=desktopState()
    state["dispatch"]=dispatch
    try requireObservationSource(request,state)
    if let dispatchError=incompleteDispatchError(dispatch!) {
      state["error"]=dispatchError
    }
    if action["kind"] as? String=="focus_window",state["focusedWindow"] as? String != action["windowBinding"] as? String {
      state["error"]=["code":"computer_focus_not_confirmed","message":"The activation request was dispatched but target focus is not confirmed."]
    }
    do {
      return try addCapture(state,nil)
    }
    catch {
      state["error"]=["code":"computer_post_action_capture_failed","message":"Input dispatch settled but its subsequent capture failed; inspect before repeating input."]
      return state
    }
  }
  catch {
    let code=(error as? NativeFailure)?.code ?? "macos_native_operation_failed"
    state["error"]=["code":code,"message":"The native desktop operation could not complete."]
    if request["operation"] as? String=="act" {
      state["dispatch"]=dispatch ?? ["status":"not_dispatched","requestedInputCount":actionCount(request["action"] as? [String:Any] ?? [:]),"acceptedInputCount":0,"reason":code]
    }
    return state
  }
}
let operationQueue=DispatchQueue(label:"abot.computer.operations"),pendingLock=NSLock()
var cancellations=[String:CancellationFlag]()
func shutdownNativeHelper() {
  pendingLock.lock()
  for cancel in cancellations.values { cancel.cancel() }
  pendingLock.unlock()
  operationQueue.async { exit(0) }
}
signal(SIGTERM,SIG_IGN)
let terminationSource=DispatchSource.makeSignalSource(signal:SIGTERM,queue:.global())
terminationSource.setEventHandler { shutdownNativeHelper() }
terminationSource.resume()
DispatchQueue.global().async {
  while let line=readLine() {
    guard line.utf8.count<=65536,let data=line.data(using:.utf8),let message=(try? JSONSerialization.jsonObject(with:data)) as? [String:Any] else {
      break
    }
    if message["type"] as? String=="close" {
      break
    }
    guard let id=message["id"] as? String else {
      break
    }
    if message["type"] as? String=="cancel" {
      pendingLock.lock()
      cancellations[id]?.cancel()
      pendingLock.unlock()
      continue
    }
    guard message["type"] as? String=="request",let request=message["request"] as? [String:Any] else {
      break
    }
    let cancel=CancellationFlag()
    pendingLock.lock()
    cancellations[id]=cancel
    pendingLock.unlock()
    operationQueue.async {
      emit(["type":"result","id":id,"result":perform(id,request,cancel)])
      pendingLock.lock()
      cancellations.removeValue(forKey:id)
      pendingLock.unlock()
    }
  }
  shutdownNativeHelper()
}
RunLoop.main.run()
`;

export const MACOS_COMPUTER_HELPER = [
  MACOS_DESKTOP_SOURCE,
  MACOS_TOPOLOGY_SOURCE,
  MACOS_CAPTURE_SOURCE,
  MACOS_INPUT_SOURCE,
  MACOS_COMMAND_LOOP,
].join("\n");
