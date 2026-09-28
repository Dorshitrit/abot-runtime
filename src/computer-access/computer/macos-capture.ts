export const MACOS_CAPTURE_SOURCE = String.raw`
func requireObservationSource(_ request:[String:Any],_ state:[String:Any]) throws {
  guard request["region"] != nil || request["operation"] as? String == "act" else { return }
  guard let desktop=state["desktop"] as? [String:Any] else { throw NativeFailure("computer_desktop_stale") }
  guard request["desktopBinding"] as? String == desktop["binding"] as? String else {
    throw NativeFailure("computer_desktop_stale")
  }
  guard let geometry=readRect(request["expectedGeometry"]),geometry==readRect(desktop["bounds"]) else {
    throw NativeFailure("computer_geometry_changed")
  }
}
func requireCaptureSourceGeometry(_ state:[String:Any],_ bounds:CGRect) throws {
  guard let desktop=state["desktop"] as? [String:Any],let source=readRect(desktop["bounds"]) else {
    throw NativeFailure("computer_geometry_changed")
  }
  guard source==bounds else { throw NativeFailure("computer_geometry_changed") }
  _ = try requireDesktopSourceBinding(desktop["binding"] as? String)
}
final class CaptureValue<T> {
  let lock=NSLock()
  var value:T?
  var error:Error?
  func store(_ value:T?,_ error:Error?) {
    lock.lock()
    self.value=value
    self.error=error
    lock.unlock()
  }
}
@available(macOS 14.0,*)
func captureScreens(_ region:CGRect,_ binding:String?) throws -> (Data,Int,Int) {
  let contentValue=CaptureValue<SCShareableContent>(),ready=DispatchSemaphore(value:0)
  SCShareableContent.getExcludingDesktopWindows(false,onScreenWindowsOnly:true) {
    content,error in contentValue.store(content,error)
    ready.signal()
  }
  guard ready.wait(timeout:.now()+10) == .success,let content=contentValue.value else {
    throw NativeFailure("macos_shareable_content_unavailable")
  }
  let source=try requireDesktopSourceBinding(binding)
  let scale=min(1.0,2048.0/max(region.width,region.height))
  let width=max(1,Int(ceil(region.width*scale))),height=max(1,Int(ceil(region.height*scale)))
  guard let space=CGColorSpace(name:CGColorSpace.sRGB),let canvas=CGContext(data:nil,width:width,height:height,bitsPerComponent:8,bytesPerRow:width*4,space:space,bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue) else {
    throw NativeFailure("macos_capture_buffer_unavailable")
  }
  canvas.setFillColor(CGColor(gray:0,alpha:1))
  canvas.fill(CGRect(x:0,y:0,width:CGFloat(width),height:CGFloat(height)))
  var captured=0
  for identifier in source.displays {
    guard let display=content.displays.first(where: { $0.displayID==identifier }) else {
      throw NativeFailure("macos_capture_source_unavailable")
    }
    let displayFrame=CGDisplayBounds(display.displayID),part=region.intersection(displayFrame)
    if part.isNull || part.isEmpty {
      continue
    }
    let configuration=SCStreamConfiguration()
    configuration.width=max(1,Int(ceil(part.width*scale)))
    configuration.height=max(1,Int(ceil(part.height*scale)))
    configuration.sourceRect=CGRect(x:part.minX-displayFrame.minX,y:part.minY-displayFrame.minY,width:part.width,height:part.height)
    configuration.showsCursor=true
    let filter=SCContentFilter(display:display,excludingWindows:[])
    let imageValue=CaptureValue<CGImage>(),imageReady=DispatchSemaphore(value:0)
    SCScreenshotManager.captureImage(contentFilter:filter,configuration:configuration) {
      image,error in imageValue.store(image,error)
      imageReady.signal()
    }
    guard imageReady.wait(timeout:.now()+10) == .success,let image=imageValue.value else {
      throw NativeFailure("macos_capture_failed")
    }
    let destination=CGRect(x:(part.minX-region.minX)*scale,y:(region.maxY-part.maxY)*scale,width:part.width*scale,height:part.height*scale)
    canvas.draw(image,in:destination)
    captured+=1
  }
  guard captured>0,let image=canvas.makeImage() else {
    throw NativeFailure("macos_capture_empty")
  }
  let output=NSMutableData()
  guard let destination=CGImageDestinationCreateWithData(output as CFMutableData,"public.png" as CFString,1,nil) else {
    throw NativeFailure("macos_png_encoder_unavailable")
  }
  let properties:[CFString:Any] = [kCGImagePropertyPNGDictionary:[kCGImagePropertyPNGInterlaceType:0]]
  CGImageDestinationAddImage(destination,image,properties as CFDictionary)
  guard CGImageDestinationFinalize(destination),output.length<=10*1024*1024 else {
    throw NativeFailure("computer_capture_size_limit")
  }
  return (output as Data,width,height)
}
func addCapture(_ state:[String:Any],_ requested:Any?) throws -> [String:Any] {
  guard #available(macOS 14.0,*) else {
    throw NativeFailure("macos14_capture_required")
  }
  guard sessionAvailable() else {
    throw NativeFailure("macos_session_locked_or_unavailable")
  }
  if !CGPreflightScreenCaptureAccess() { _ = CGRequestScreenCaptureAccess() }
  guard CGPreflightScreenCaptureAccess() else { throw NativeFailure("macos_screen_recording_permission_required") }
  let bounds=displayBounds(),region=readRect(requested) ?? bounds
  try requireCaptureSourceGeometry(state,bounds)
  guard bounds.contains(region),region.width>0,region.height>0 else {
    throw NativeFailure("computer_region_outside_desktop")
  }
  let desktop=state["desktop"] as? [String:Any]
  let (image,width,height)=try captureScreens(region,desktop?["binding"] as? String)
  guard sessionAvailable(),displayBounds()==bounds else {
    throw NativeFailure("computer_geometry_changed_during_capture")
  }
  let (nodes,truncated)=accessibilitySnapshot(state["focusedWindow"] as? String)
  let current=desktopState()
  try requireCaptureSourceGeometry(state,bounds)
  guard state["focusedWindow"] as? String == current["focusedWindow"] as? String else { throw NativeFailure("computer_focus_changed_during_capture") }
  var result=state
  result["observation"]=["capturedAt":ISO8601DateFormatter().string(from:Date()),"region":rectJSON(region),"imageWidth":width,"imageHeight":height,"accessibility":nodes,"accessibilityTruncated":truncated]
  result["imageBase64"]=image.base64EncodedString()
  return result
}
`;
