/** Pixel capture and image bounds. Cropped pixels remain visible desktop pixels, including occlusion. */
export const WINDOWS_CAPTURE_SCRIPT = String.raw`
public static partial class AbotComputer {
  static void RequireObservationSource(Dictionary<string,object> request,Dictionary<string,object> result) {
    if(Field(request,"region")==null && Field(request,"operation") as string!="act") return;
    var desktop=Record(result["desktop"]);
    if(Text(request,"desktopBinding",4096)!=(string)desktop["binding"])
      throw new ComputerFault("computer_desktop_stale","The capture belongs to a different desktop observation.");
    if(!SameRectangle(ParseRectangle(request["expectedGeometry"]),ParseRectangle(desktop["bounds"])))
      throw new ComputerFault("computer_geometry_changed","The display geometry changed before capture.");
  }
  static void CaptureObservation(Dictionary<string,object> result,object requestedRegion) {
    RequireAvailableDesktop(result);
    var desktop=Record(result["desktop"]);
    string binding=(string)desktop["binding"];
    Rect virtualBounds=ParseRectangle(desktop["bounds"]);
    Rect region=requestedRegion==null?virtualBounds:ParseRectangle(requestedRegion);
    if(!ContainsRectangle(virtualBounds,region))
      throw new ComputerFault("computer_region_outside_desktop","The requested region is outside the physical desktop.");
    int width=region.Right-region.Left,height=region.Bottom-region.Top;
    if((long)width*height>64000000)
      throw new ComputerFault("computer_capture_too_large","Select a smaller physical capture region.");
    string foreground=NativeWindowBinding(GetForegroundWindow());
    if(!Object.Equals(Field(result,"focusedWindow"),foreground))
      throw new ComputerFault("computer_focus_changed","Focus changed before capture; obtain a fresh observation.");
    VerifyDesktopBinding(binding);
    int imageWidth,imageHeight;
    byte[] image=CapturePixels(region,out imageWidth,out imageHeight);
    bool truncated;
    var accessibility=ReadAccessibility(region,out truncated);
    VerifyDesktopBinding(binding);
    if(!SameRectangle(VirtualDesktopBounds(),virtualBounds))
      throw new ComputerFault("computer_geometry_changed","The display geometry changed during observation.");
    if(NativeWindowBinding(GetForegroundWindow())!=foreground)
      throw new ComputerFault("computer_focus_changed","Focus changed during observation; obtain a fresh observation.");
    result["observation"]=Obj("capturedAt",DateTime.UtcNow.ToString("o"),
      "region",Rectangle(region.Left,region.Top,width,height),"imageWidth",imageWidth,"imageHeight",imageHeight,
      "accessibility",accessibility,"accessibilityTruncated",truncated);
    result["image"]=Obj("mimeType","image/png","base64",Convert.ToBase64String(image));
  }
  static byte[] CapturePixels(Rect region,out int imageWidth,out int imageHeight) {
    int width=region.Right-region.Left,height=region.Bottom-region.Top;
    using(var original=new Bitmap(width,height,PixelFormat.Format32bppArgb)) {
      using(var graphics=Graphics.FromImage(original)) {
        graphics.CopyFromScreen(region.Left,region.Top,0,0,new Size(width,height),CopyPixelOperation.SourceCopy);
      }
      int maxDimension=2048;
      while(maxDimension>=256) {
        double scale=Math.Min(1.0,(double)maxDimension/Math.Max(width,height));
        imageWidth=Math.Max(1,(int)Math.Round(width*scale));
        imageHeight=Math.Max(1,(int)Math.Round(height*scale));
        using(var resized=new Bitmap(imageWidth,imageHeight,PixelFormat.Format32bppArgb)) {
          using(var graphics=Graphics.FromImage(resized)) {
            graphics.InterpolationMode=System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
            graphics.DrawImage(original,0,0,imageWidth,imageHeight);
          }
          using(var stream=new MemoryStream()) {
            resized.Save(stream,ImageFormat.Png);
            if(stream.Length<=ImageMaxBytes) return stream.ToArray();
          }
        }
        maxDimension/=2;
      }
    }
    imageWidth=0; imageHeight=0;
    throw new ComputerFault("computer_capture_too_large","The screenshot exceeds the image byte limit.");
  }
}
`;
