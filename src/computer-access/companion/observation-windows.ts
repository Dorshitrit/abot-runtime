/** A single native event loop. Timers only settle observed changes; they never poll the desktop. */
import { OBSERVATION_CAPTURE_POLICY as policy } from "./observation-capture-policy.js";
export const WINDOWS_OBSERVATION_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
Add-Type -ReferencedAssemblies @('UIAutomationClient','UIAutomationTypes','WindowsBase','System.Windows.Forms','System.Web.Extensions') -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Windows.Automation;
using System.Windows.Forms;
using System.Web.Script.Serialization;
public static class PassiveDesktop {
  delegate void WinEvent(IntPtr h,uint e,IntPtr w,int obj,int child,uint thread,uint time);
  [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint min,uint max,IntPtr module,WinEvent callback,uint pid,uint thread,uint flags);
  [DllImport("user32.dll")] static extern bool UnhookWinEvent(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern IntPtr OpenInputDesktop(uint flags,bool inherit,uint access);
  [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern bool GetUserObjectInformation(IntPtr h,int index,System.Text.StringBuilder text,int size,out int required);
  static JavaScriptSerializer json = new JavaScriptSerializer();
  static HashSet<string> excluded = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
  static Timer quiet = new Timer { Interval=1200 };
  static Timer maximum = new Timer { Interval=5000 };
  static readonly Stopwatch cadence = Stopwatch.StartNew();
  static long lastCapture=-${policy.minimumIntervalMs}, burstStarted;
  static int burstCaptures, queuedChange;
  static bool noisePaused;
  static Form dispatch;
  static bool edited;
  static string editKey;
  static WinEvent callback;
  static IntPtr hook;
  static AutomationFocusChangedEventHandler focus;
  static AutomationPropertyChangedEventHandler properties;
  static StructureChangedEventHandler structure;
  static AutomationEventHandler text;
  static IntPtr currentWindow;
  static void Emit(object value) { Console.WriteLine(json.Serialize(value)); }
  static void Status(string state,string reason) { Emit(new {type="status",state=state,reason=reason}); }
  static bool AccessibleDesktop() {
    IntPtr desktop=OpenInputDesktop(0,false,0x0001);
    if(desktop==IntPtr.Zero) return false;
    try { int needed; var name=new System.Text.StringBuilder(128); return GetUserObjectInformation(desktop,2,name,256,out needed) && name.ToString()=="Default"; }
    finally { CloseDesktop(desktop); }
  }
  static bool Editable(object sender) {
    try { var element=sender as AutomationElement; object pattern; if(element==null || element.Current.IsPassword) return false;
      var ancestor=element; bool foreground=false;
      for(int i=0;i<32 && ancestor!=null;i++) { if((IntPtr)ancestor.Current.NativeWindowHandle==GetForegroundWindow()) {foreground=true;break;} ancestor=TreeWalker.ControlViewWalker.GetParent(ancestor); }
      if(!foreground) return false;
      return element.TryGetCurrentPattern(ValuePattern.Pattern,out pattern) && !((ValuePattern)pattern).Current.IsReadOnly;
    } catch { return false; }
  }
  static void Changed(bool edit, bool switched=false) {
    if(dispatch==null || dispatch.IsDisposed) return;
    if(!edit && !switched && System.Threading.Interlocked.Exchange(ref queuedChange,1)==1) return;
    string source=null;
    if(edit) { try {source=Key(AutomationElement.FromHandle(GetForegroundWindow()));} catch {} }
    dispatch.BeginInvoke((Action)(()=> {
      System.Threading.Interlocked.Exchange(ref queuedChange,0);
      if(edit && source!=null) {edited=true;editKey=source;}
      if(edit || switched) {noisePaused=false;burstCaptures=0;burstStarted=cadence.ElapsedMilliseconds;}
      quiet.Stop(); quiet.Interval=noisePaused?${policy.resumeQuietMs}:1200; quiet.Start();
      if(!noisePaused && !maximum.Enabled) maximum.Start();
    }));
  }
  static AutomationElement Document(AutomationElement root) {
    try { var item=AutomationElement.FocusedElement;
      if(item.Current.ProcessId!=root.Current.ProcessId) return null;
      for(int depth=0;depth<32 && item!=null;depth++) {
        if(item.Current.ControlType==ControlType.Document) return item;
        if(item.Equals(root)) return null;
        item=TreeWalker.ControlViewWalker.GetParent(item);
      }
    } catch {}
    return null;
  }
  static string DocumentId(AutomationElement root) { var document=Document(root); return document==null?"":String.Join("-",document.GetRuntimeId()); }
  static bool VisibleLeaf(AutomationElement item, System.Windows.Rect window) {
    var bounds=item.Current.BoundingRectangle;
    return !bounds.IsEmpty && bounds.Width>0 && bounds.Height>0 && bounds.IntersectsWith(window);
  }
  static string Key(AutomationElement root) { return root.Current.NativeWindowHandle.ToString()+":"+root.Current.ProcessId.ToString()+":"+root.Current.Name+":"+DocumentId(root); }
  static void Bind(AutomationElement root) {
    IntPtr window=(IntPtr)root.Current.NativeWindowHandle;
    if(window==currentWindow) return;
    Automation.RemoveAllEventHandlers(); currentWindow=window;
    Automation.AddAutomationFocusChangedEventHandler(focus);
    Automation.AddAutomationPropertyChangedEventHandler(root,TreeScope.Subtree,properties,ValuePattern.ValueProperty,AutomationElement.NameProperty,AutomationElement.IsOffscreenProperty);
    Automation.AddStructureChangedEventHandler(root,TreeScope.Subtree,structure);
    Automation.AddAutomationEventHandler(TextPattern.TextChangedEvent,root,TreeScope.Subtree,text);
  }
  static void Capture() {
    quiet.Stop(); maximum.Stop();
    long now=cadence.ElapsedMilliseconds;
    if(noisePaused) {noisePaused=false;burstCaptures=0;}
    if(now-lastCapture<${policy.minimumIntervalMs}) {quiet.Interval=(int)(${policy.minimumIntervalMs}-(now-lastCapture));quiet.Start();return;}
    if(now-burstStarted>${policy.burstWindowMs}) {burstStarted=now;burstCaptures=0;}
    if(!edited && ++burstCaptures>${policy.burstLimit}) {
      noisePaused=true;Status("paused","continuous_activity");quiet.Interval=${policy.resumeQuietMs};quiet.Start();return;
    }
    lastCapture=now; bool edit=edited; edited=false;
    try {
      if(!AccessibleDesktop()) { Status("paused","screen_locked_or_secure_desktop"); return; }
      IntPtr window=GetForegroundWindow(); if(window==IntPtr.Zero) return;
      var root=AutomationElement.FromHandle(window); int pid=root.Current.ProcessId;
      string app=Process.GetProcessById(pid).ProcessName;
      if(excluded.Contains(app)) { Status("paused","application_excluded"); return; }
      Bind(root);
      string before=Key(root); string title=root.Current.Name; edit=edit && editKey==before;
      string documentId=DocumentId(root);
      var document=Document(root); var windowBounds=root.Current.BoundingRectangle;
      var queue=new Queue<AutomationElement>(); queue.Enqueue(document ?? root);
      var parts=new List<string>(); var seen=new HashSet<string>(); int length=0; int count=0;
      var watch=Stopwatch.StartNew(); var walker=TreeWalker.ControlViewWalker;
      while(queue.Count>0 && count++<600 && length<24000 && watch.ElapsedMilliseconds<400) {
        var item=queue.Dequeue();
        try {
          if(item.Current.IsPassword || item.Current.IsOffscreen) continue;
          // A root fallback must not read background browser document trees.
          if(document==null && item.Current.ControlType==ControlType.Document) continue;
          var child=walker.GetFirstChild(item);
          // Parent TextPattern may include protected descendants. Extract only visible leaf controls.
          if(child==null && VisibleLeaf(item,windowBounds)) {
            string value=null; object pattern;
            if(item.TryGetCurrentPattern(ValuePattern.Pattern,out pattern)) value=((ValuePattern)pattern).Current.Value;
            else if(item.TryGetCurrentPattern(TextPattern.Pattern,out pattern)) {
              var visibleParts=new List<string>(); int remaining=24000-length;
              foreach(var range in ((TextPattern)pattern).GetVisibleRanges()) {
                if(remaining<=0 || watch.ElapsedMilliseconds>=400) break;
                string visible=range.GetText(remaining);
                if(!String.IsNullOrEmpty(visible)) { visibleParts.Add(visible); remaining-=visible.Length; }
              }
              value=String.Join("\n",visibleParts.ToArray());
            }
            else if(item.Current.ControlType==ControlType.Text) value=item.Current.Name;
            if(!String.IsNullOrWhiteSpace(value) && seen.Add(value)) { parts.Add(value); length+=value.Length; }
          }
          int siblings=0;
          while(child!=null && siblings++<600 && queue.Count<600) { queue.Enqueue(child); child=walker.GetNextSibling(child); }
        } catch(ElementNotAvailableException) {}
      }
      if(GetForegroundWindow()!=window || !AccessibleDesktop()) return;
      string after=Key(AutomationElement.FromHandle(window)); if(before!=after) return;
      string content=String.Join("\n",parts.ToArray());
      if(content.Length>24000) content=content.Substring(0,24000);
      Emit(new {type="snapshot",source=new {app=app,processId=pid,windowId=window.ToString(),documentId=documentId,title=title},content=content,kind=edit?"edit":"view",extraction="uia",coverage=content.Length>0?"partial":"metadata_only",coverageReason="visible_accessibility_subset",beforeKey=before,afterKey=after});
      Status("partial","uia_application_coverage");
    } catch(Exception) { Status("partial","accessibility_read_unavailable"); }
  }
  public static void Run(string exclusions) {
    foreach(string app in json.Deserialize<string[]>(exclusions)) excluded.Add(app);
    dispatch=new Form { ShowInTaskbar=false,WindowState=FormWindowState.Minimized };
    var handle=dispatch.Handle;
    quiet.Tick+=(s,e)=>Capture(); maximum.Tick+=(s,e)=>Capture();
    focus=(s,e)=>Changed(false); properties=(s,e)=>Changed(e.Property==ValuePattern.ValueProperty && Editable(s));
    structure=(s,e)=>Changed(false); text=(s,e)=>Changed(Editable(s));
    callback=(h,e,w,obj,child,thread,time)=>Changed(false,true);
    hook=SetWinEventHook(3,3,IntPtr.Zero,callback,0,0,0);
    if(hook==IntPtr.Zero) { Status("unavailable","foreground_events_unavailable"); return; }
    Automation.AddAutomationFocusChangedEventHandler(focus);
    Status("partial","uia_application_coverage"); Changed(false);
    try { Application.Run(); }
    finally { UnhookWinEvent(hook); Automation.RemoveAllEventHandlers(); dispatch.Dispose(); }
  }
}
'@
[PassiveDesktop]::Run($env:ABOT_OBSERVATION_EXCLUSIONS)
} catch { [Console]::WriteLine('{"type":"status","state":"unavailable","reason":"windows_uia_helper_unavailable"}') }
`;
