/** Native login/desktop identity and window inspection; never infers browser tabs. */
export const WINDOWS_DESKTOP_SCRIPT = String.raw`
public static partial class AbotComputer {
  static Dictionary<string,object> Capability(bool available,string reason) {
    var result=Obj("supported",true,"available",available);
    if(!String.IsNullOrEmpty(reason)) result["reason"]=reason;
    return result;
  }
  static Dictionary<string,object> UnavailableResult(string reason) {
    return Obj("desktop",Obj("platform","windows","binding","windows:unavailable",
      "name","Windows desktop","available",false,"reason",reason,"bounds",Rectangle(0,0,1,1),
      "capabilities",Obj("capture",Capability(false,reason),"accessibility",Capability(false,reason),
        "input",Capability(false,reason),"windows",Capability(false,reason)),
      "targetingGuarantee","observed_surface"),"windows",new object[0]);
  }
  static string NativeLogonIdentity() {
    IntPtr token;
    if(!OpenProcessToken(Process.GetCurrentProcess().Handle,0x0008,out token)) return null;
    try {
      TokenStatistics information; int needed;
      if(!GetTokenInformation(token,10,out information,Marshal.SizeOf(typeof(TokenStatistics)),out needed)) return null;
      return information.AuthenticationId.High.ToString("X8")+information.AuthenticationId.Low.ToString("X8");
    } finally { CloseHandle(token); }
  }
  static string InputDesktopName() {
    IntPtr desktop=OpenInputDesktop(0,false,0x0001);
    if(desktop==IntPtr.Zero) return null;
    try {
      var name=new StringBuilder(128); int needed;
      if(!GetUserObjectInformation(desktop,2,name,name.Capacity*2,out needed)) return null;
      return name.ToString();
    } finally { CloseDesktop(desktop); }
  }
  static Rect VirtualDesktopBounds() {
    int x=GetSystemMetrics(76),y=GetSystemMetrics(77);
    return new Rect { Left=x,Top=y,Right=x+GetSystemMetrics(78),Bottom=y+GetSystemMetrics(79) };
  }
  static string ReadDesktopBinding(out string reason) {
    reason=null;
    int session=Process.GetCurrentProcess().SessionId;
    if(session==0) { reason="interactive_session_unavailable"; return null; }
    string desktop=InputDesktopName();
    if(desktop!="Default") { reason="screen_locked_or_secure_desktop"; return null; }
    string logon=NativeLogonIdentity();
    if(logon==null) { reason="login_identity_unavailable"; return null; }
    string topology;
    try { topology=ReadCaptureTopology(); }
    catch(ComputerFault fault) { reason=fault.Code; return null; }
    return "windows:"+Environment.MachineName+":"+session+":"+logon+":"+desktop+":"+topology;
  }
  static string NativeWindowBinding(IntPtr window) {
    if(window==IntPtr.Zero || !IsWindow(window)) return null;
    uint processId; GetWindowThreadProcessId(window,out processId);
    if(processId==0) return null;
    try {
      using(var process=Process.GetProcessById((int)processId)) {
        return window.ToInt64().ToString("X")+":"+processId+":"+process.StartTime.ToUniversalTime().Ticks;
      }
    } catch { return null; }
  }
  static IntPtr ResolveWindowBinding(string binding) {
    string[] parts=binding.Split(':'); long handle;
    if(parts.Length!=3 || !Int64.TryParse(parts[0],System.Globalization.NumberStyles.HexNumber,
      System.Globalization.CultureInfo.InvariantCulture,out handle))
      throw new ComputerFault("computer_window_stale","The window reference is invalid.");
    var window=new IntPtr(handle);
    if(NativeWindowBinding(window)!=binding)
      throw new ComputerFault("computer_window_stale","The selected native window no longer exists.");
    return window;
  }
  static Dictionary<string,object> ReadWindow(IntPtr window,IntPtr foreground) {
    if(!IsWindowVisible(window)) return null;
    string binding=NativeWindowBinding(window);
    if(binding==null) return null;
    Rect bounds;
    if(!GetWindowRect(window,out bounds)) return null;
    if(bounds.Right<=bounds.Left || bounds.Bottom<=bounds.Top) return null;
    var title=new StringBuilder(513); GetWindowText(window,title,title.Capacity);
    var result=Obj("binding",binding,"title",title.ToString(),
      "bounds",Rectangle(bounds.Left,bounds.Top,bounds.Right-bounds.Left,bounds.Bottom-bounds.Top),
      "focused",window==foreground);
    try {
      uint processId; GetWindowThreadProcessId(window,out processId);
      using(var process=Process.GetProcessById((int)processId)) result["application"]=process.ProcessName;
    } catch {}
    return result;
  }
  static Dictionary<string,object> DesktopSnapshot() {
    string reason; string binding=ReadDesktopBinding(out reason);
    if(binding==null) return UnavailableResult(reason);
    Rect bounds=VirtualDesktopBounds();
    if(bounds.Right<=bounds.Left || bounds.Bottom<=bounds.Top) return UnavailableResult("desktop_geometry_unavailable");
    IntPtr foreground=GetForegroundWindow();
    string focused=NativeWindowBinding(foreground);
    var windows=new List<object>(); int windowBytes=0;
    // Capture the foreground first so bounded enumeration cannot omit the selected source.
    var active=ReadWindow(foreground,foreground);
    if(active!=null) { windows.Add(active); windowBytes=Encoding.UTF8.GetByteCount(Json.Serialize(active)); }
    EnumWindowCallback callback=(window,parameter)=> {
      if(window==foreground) return true;
      if(windows.Count>=128 || windowBytes>=32768) return false;
      var value=ReadWindow(window,foreground);
      if(value==null) return true;
      int bytes=Encoding.UTF8.GetByteCount(Json.Serialize(value));
      if(windowBytes+bytes>32768) return false;
      windows.Add(value); windowBytes+=bytes; return true;
    };
    EnumWindows(callback,IntPtr.Zero);
    var result=Obj("desktop",Obj("platform","windows","binding",binding,
      "name",Environment.MachineName+" / Windows desktop","available",true,
      "bounds",Rectangle(bounds.Left,bounds.Top,bounds.Right-bounds.Left,bounds.Bottom-bounds.Top),
      "capabilities",Obj("capture",Capability(true,null),"accessibility",Capability(true,"visible_accessibility_subset"),
        "input",Capability(true,"uipi_may_restrict_input"),"windows",Capability(true,"window_enumeration_bounded")),
      "targetingGuarantee",focused==null?"observed_surface":"verified_window"),"windows",windows);
    if(focused!=null) result["focusedWindow"]=focused;
    return result;
  }
  static void RequireAvailableDesktop(Dictionary<string,object> result) {
    var desktop=Record(result["desktop"]);
    if(!Object.Equals(Field(desktop,"available"),true))
      throw new ComputerFault("computer_desktop_unavailable","The interactive desktop is unavailable or locked.");
  }
  static void VerifyDesktopBinding(string expected) {
    string reason;
    if(ReadDesktopBinding(out reason)!=expected)
      throw new ComputerFault("computer_desktop_changed","The login or interactive desktop changed.");
  }
}
`;
