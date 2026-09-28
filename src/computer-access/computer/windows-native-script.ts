/** Shared native declarations and strict mechanical decoding for the one-shot helper. */
export const WINDOWS_NATIVE_SCRIPT = String.raw`
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Automation;

public static partial class AbotComputer {
  static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength=15000000, RecursionLimit=64 };
  const int ImageMaxBytes=10485760;
  [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left,Top,Right,Bottom; }
  [StructLayout(LayoutKind.Sequential)] struct Point { public int X,Y; }
  [StructLayout(LayoutKind.Sequential)] struct Luid { public uint Low; public int High; }
  [StructLayout(LayoutKind.Sequential)] struct TokenStatistics {
    public Luid TokenId,AuthenticationId; public long ExpirationTime;
    public int TokenType,ImpersonationLevel; public uint DynamicCharged,DynamicAvailable,GroupCount,PrivilegeCount;
    public Luid ModifiedId;
  }
  delegate bool EnumWindowCallback(IntPtr window,IntPtr parameter);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr window);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window,out Rect rectangle);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowCallback callback,IntPtr parameter);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr window,StringBuilder text,int count);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window,out uint processId);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] static extern IntPtr OpenInputDesktop(uint flags,bool inherit,uint access);
  [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern bool GetUserObjectInformation(IntPtr obj,int index,StringBuilder text,int size,out int required);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr window,int command);
  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetTokenInformation(IntPtr token,int type,out TokenStatistics information,int length,out int needed);
  [DllImport("dwmapi.dll")] static extern int DwmFlush();

  sealed class ComputerFault : Exception {
    public readonly string Code;
    public ComputerFault(string code,string message):base(message) { Code=code; }
  }
  static Dictionary<string,object> Obj(params object[] pairs) {
    var result=new Dictionary<string,object>();
    for(int i=0;i<pairs.Length;i+=2) result.Add((string)pairs[i],pairs[i+1]);
    return result;
  }
  static Dictionary<string,object> Record(object value) {
    var result=value as Dictionary<string,object>;
    if(result==null) throw new ComputerFault("computer_request_invalid","Expected a structured object.");
    return result;
  }
  static object Field(Dictionary<string,object> value,string key) {
    object result; return value.TryGetValue(key,out result)?result:null;
  }
  static string Text(Dictionary<string,object> value,string key,int limit) {
    var result=Field(value,key) as string;
    if(result==null || result.Length>limit) throw new ComputerFault("computer_request_invalid","Invalid text field: "+key);
    return result;
  }
  static double Number(Dictionary<string,object> value,string key) {
    object raw=Field(value,key);
    if(!(raw is int) && !(raw is long) && !(raw is decimal) && !(raw is double))
      throw new ComputerFault("computer_request_invalid","Invalid numeric field: "+key);
    double result=Convert.ToDouble(raw);
    if(Double.IsInfinity(result) || Double.IsNaN(result)) throw new ComputerFault("computer_request_invalid","Non-finite number.");
    return result;
  }
  static int Integer(Dictionary<string,object> value,string key,int min,int max) {
    double number=Number(value,key);
    if(number!=Math.Truncate(number) || number<min || number>max)
      throw new ComputerFault("computer_request_invalid","Out-of-range integer: "+key);
    return (int)number;
  }
  static Dictionary<string,object> Rectangle(int x,int y,int width,int height) {
    return Obj("x",x,"y",y,"width",width,"height",height);
  }
  static Rect ParseRectangle(object value) {
    var data=Record(value);
    int x=PhysicalPixel(data,"x",-131072,131072),y=PhysicalPixel(data,"y",-131072,131072);
    int width=PhysicalPixel(data,"width",1,65536),height=PhysicalPixel(data,"height",1,65536);
    return new Rect { Left=x,Top=y,Right=x+width,Bottom=y+height };
  }
  static int PhysicalPixel(Dictionary<string,object> data,string key,int min,int max) {
    double number=Number(data,key);
    if(number<min || number>max) throw new ComputerFault("computer_request_invalid","Invalid physical pixel field: "+key);
    return (int)Math.Round(number);
  }
  static bool SameRectangle(Rect left,Rect right) {
    if(left.Left!=right.Left) return false;
    if(left.Top!=right.Top) return false;
    if(left.Right!=right.Right) return false;
    return left.Bottom==right.Bottom;
  }
  static bool ContainsRectangle(Rect outer,Rect inner) {
    if(inner.Left<outer.Left || inner.Top<outer.Top) return false;
    if(inner.Right>outer.Right || inner.Bottom>outer.Bottom) return false;
    return inner.Right>inner.Left && inner.Bottom>inner.Top;
  }
  static bool HasExpiredAction(Dictionary<string,object> request) {
    return DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()>Number(request,"deadlineEpochMs");
  }
  static void PreparePhysicalCoordinates() {
    try { if(SetThreadDpiAwarenessContext(new IntPtr(-4))!=IntPtr.Zero) return; }
    catch(EntryPointNotFoundException) {}
    SetProcessDPIAware();
  }
  static void SetError(Dictionary<string,object> result,Exception error) {
    if(result.ContainsKey("error")) return;
    var fault=error as ComputerFault;
    result["error"]=Obj("code",fault==null?"computer_native_failed":fault.Code,
      "message",fault==null?"The native observation or input operation failed.":fault.Message);
  }
  public static string Run(string requestJson) {
    Dictionary<string,object> result=UnavailableResult("computer_native_failed");
    Dictionary<string,object> request=null;
    DispatchState dispatch=null;
    try {
      request=Record(Json.DeserializeObject(requestJson));
      string operation=Text(request,"operation",32);
      if(operation!="inspect" && operation!="observe" && operation!="act")
        throw new ComputerFault("computer_request_invalid","Unknown native operation.");
      if(operation=="act") dispatch=new DispatchState();
      PreparePhysicalCoordinates();
      result=DesktopSnapshot();
      if(operation=="inspect") return Json.Serialize(result);
      if(operation=="observe") RequireObservationSource(request,result);
      if(operation=="act") {
        try {
          Act(request,result,dispatch);
          if(dispatch.Failure!=null) throw new ComputerFault(dispatch.Failure,"Input cleanup was not fully accepted by Windows.");
        } catch(Exception error) { dispatch.Fail(error); SetError(result,error); }
        object actionError=Field(result,"error");
        result=DesktopSnapshot();
        RequireObservationSource(request,result);
        if(actionError!=null) result["error"]=actionError;
        if(dispatch.Started) { try { DwmFlush(); } catch(DllNotFoundException) {} }
      }
      try { CaptureObservation(result,operation=="observe"?Field(request,"region"):null); }
      catch(Exception error) { SetError(result,error); }
    } catch(Exception error) { SetError(result,error); }
    if(dispatch!=null) result["dispatch"]=dispatch.Result();
    return Json.Serialize(result);
  }
}
`;
