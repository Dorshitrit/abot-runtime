/** Mechanical action binding, native input receipts and pointer operations. */
export const WINDOWS_INPUT_SCRIPT = String.raw`
public static partial class AbotComputer {
  [StructLayout(LayoutKind.Sequential)] struct MouseInput {
    public int X,Y; public uint Data,Flags,Time; public UIntPtr Extra;
  }
  [StructLayout(LayoutKind.Sequential)] struct KeyboardInput {
    public ushort Key,Scan; public uint Flags,Time; public UIntPtr Extra;
  }
  [StructLayout(LayoutKind.Explicit)] struct InputUnion {
    [FieldOffset(0)] public MouseInput Mouse;
    [FieldOffset(0)] public KeyboardInput Keyboard;
  }
  [StructLayout(LayoutKind.Sequential)] struct NativeInput { public uint Type; public InputUnion Data; }
  [DllImport("user32.dll",SetLastError=true)] static extern uint SendInput(uint count,NativeInput[] inputs,int size);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromPoint(Point point,uint flags);

  sealed class DispatchState {
    public int Requested,Accepted; public bool Started,Uncertain; public string Failure;
    public void Fail(Exception error) {
      var fault=error as ComputerFault; Failure=fault==null?"native_action_failed":fault.Code;
    }
    public Dictionary<string,object> Result() {
      string status="not_dispatched";
      if(Started && Accepted>0) status=Failure==null && Accepted==Requested?"accepted":"partial";
      if(Uncertain) status="unknown";
      var result=Obj("status",status,"requestedInputCount",Requested,"acceptedInputCount",Accepted);
      if(Failure!=null) result["reason"]=Failure;
      return result;
    }
    public void Send(NativeInput[] inputs) {
      if(inputs.Length==0) return;
      Started=true; Requested+=inputs.Length;
      uint accepted=SendInput((uint)inputs.Length,inputs,Marshal.SizeOf(typeof(NativeInput)));
      Accepted+=(int)accepted;
      if(accepted!=(uint)inputs.Length)
        throw new ComputerFault("computer_input_not_accepted","Windows accepted only part or none of the input; UIPI or desktop state may restrict injection.");
    }
    public void Cleanup(NativeInput[] inputs) {
      try { Send(inputs); } catch(Exception error) { Fail(error); }
    }
  }
  static void VerifyActionPreconditions(Dictionary<string,object> request,Dictionary<string,object> result) {
    RequireAvailableDesktop(result);
    string binding=Text(request,"desktopBinding",4096);
    if((string)Record(result["desktop"])["binding"]!=binding)
      throw new ComputerFault("computer_desktop_changed","The action belongs to a different desktop observation.");
    if(!SameRectangle(ParseRectangle(request["expectedGeometry"]),VirtualDesktopBounds()))
      throw new ComputerFault("computer_geometry_changed","The display geometry changed before input dispatch.");
    string expected=Field(request,"expectedWindow") as string;
    if(expected!=null && NativeWindowBinding(GetForegroundWindow())!=expected)
      throw new ComputerFault("computer_focus_changed","The focused window changed before input dispatch.");
    VerifyActionLease(request);
  }
  static void VerifyActionLease(Dictionary<string,object> request) {
    if(HasExpiredAction(request))
      throw new ComputerFault("computer_action_expired","The action deadline passed; no remaining input will be sent.");
    VerifyDesktopBinding(Text(request,"desktopBinding",4096));
    if(!SameRectangle(ParseRectangle(request["expectedGeometry"]),VirtualDesktopBounds()))
      throw new ComputerFault("computer_geometry_changed","The display geometry changed during input dispatch.");
  }
  static void VerifyInitialInputBinding(Dictionary<string,object> request) {
    VerifyActionLease(request);
    string expected=Field(request,"expectedWindow") as string;
    if(expected!=null && NativeWindowBinding(GetForegroundWindow())!=expected)
      throw new ComputerFault("computer_focus_changed","The focused window changed before input dispatch.");
  }
  static Point InputPoint(object raw) {
    var point=Record(raw);
    double x=Number(point,"x"),y=Number(point,"y");
    if(x< -131072 || x>131072 || y< -131072 || y>131072)
      throw new ComputerFault("computer_point_invalid","Input coordinates exceed the physical desktop range.");
    var result=new Point { X=(int)Math.Round(x),Y=(int)Math.Round(y) };
    Rect bounds=VirtualDesktopBounds();
    if(result.X<bounds.Left || result.X>=bounds.Right || result.Y<bounds.Top || result.Y>=bounds.Bottom)
      throw new ComputerFault("computer_point_invalid","Input coordinates are outside the physical desktop.");
    if(MonitorFromPoint(result,0)==IntPtr.Zero)
      throw new ComputerFault("computer_point_invalid","Input coordinates are in a gap between displays.");
    return result;
  }
  static NativeInput Mouse(uint flags,int x,int y,uint data) {
    return new NativeInput { Type=0,Data=new InputUnion { Mouse=new MouseInput { X=x,Y=y,Data=data,Flags=flags } } };
  }
  static NativeInput MoveInput(Point point) {
    Rect bounds=VirtualDesktopBounds();
    int x=(int)Math.Round((double)(point.X-bounds.Left)*65535/Math.Max(1,bounds.Right-bounds.Left-1));
    int y=(int)Math.Round((double)(point.Y-bounds.Top)*65535/Math.Max(1,bounds.Bottom-bounds.Top-1));
    return Mouse(0x0001|0x8000|0x4000,x,y,0);
  }
  static uint ButtonFlag(string button,bool up) {
    if(button=="left") return up?0x0004u:0x0002u;
    if(button=="right") return up?0x0010u:0x0008u;
    if(button=="middle") return up?0x0040u:0x0020u;
    throw new ComputerFault("computer_request_invalid","Unknown pointer button.");
  }
  static void RequireNoHeldInput() {
    foreach(int key in new int[] {1,2,4,16,17,18,91,92}) {
      if((GetAsyncKeyState(key)&0x8000)!=0)
        throw new ComputerFault("computer_user_input_active","A pointer button or modifier is already held; wait for a fresh observation.");
    }
  }
  static void Act(Dictionary<string,object> request,Dictionary<string,object> result,DispatchState dispatch) {
    VerifyActionPreconditions(request,result);
    var action=Record(Field(request,"action")); string kind=Text(action,"kind",32);
    if(kind=="focus_window") { FocusWindow(action,request,dispatch); return; }
    RequireNoHeldInput();
    if(kind=="press_keys") { PressKeys(action,request,dispatch); return; }
    if(kind=="type_text") { TypeText(action,request,dispatch); return; }
    if(kind=="drag") { Drag(action,request,dispatch); return; }
    if(kind=="scroll") { Scroll(action,request,dispatch); return; }
    if(kind=="move") {
      var move=MoveInput(InputPoint(Field(action,"point"))); VerifyActionPreconditions(request,result);
      dispatch.Send(new NativeInput[] {move}); return;
    }
    if(kind!="click") throw new ComputerFault("computer_request_invalid","Unknown native input operation.");
    var point=InputPoint(Field(action,"point")); string button=Text(action,"button",16);
    int count=Integer(action,"count",1,2); uint down=ButtonFlag(button,false),up=ButtonFlag(button,true);
    var inputs=new List<NativeInput>(); inputs.Add(MoveInput(point));
    for(int i=0;i<count;i++) { inputs.Add(Mouse(down,0,0,0)); inputs.Add(Mouse(up,0,0,0)); }
    VerifyActionPreconditions(request,result);
    try { dispatch.Send(inputs.ToArray()); }
    catch { dispatch.Cleanup(new NativeInput[] {Mouse(up,0,0,0)}); throw; }
  }
  static void FocusWindow(Dictionary<string,object> action,Dictionary<string,object> request,DispatchState dispatch) {
    IntPtr window=ResolveWindowBinding(Text(action,"windowBinding",4096));
    VerifyInitialInputBinding(request);
    if(IsIconic(window)) {
      dispatch.Requested++; dispatch.Started=true; dispatch.Uncertain=true;
      ShowWindow(window,9);
      if(IsIconic(window)) throw new ComputerFault("computer_window_restore_unconfirmed","The restore request could not be confirmed.");
      dispatch.Accepted++; dispatch.Uncertain=false;
    }
    // Restore may itself have changed focus; only enforce the binding before that effect.
    VerifyActionLease(request);
    dispatch.Requested++; dispatch.Started=true; dispatch.Uncertain=true;
    SetForegroundWindow(window);
    if(GetForegroundWindow()!=window)
      throw new ComputerFault("computer_focus_not_granted","Windows did not confirm focus on the selected window.");
    dispatch.Accepted++; dispatch.Uncertain=false;
  }
  static void Scroll(Dictionary<string,object> action,Dictionary<string,object> request,DispatchState dispatch) {
    int x=(int)Math.Round(Number(action,"deltaX")),y=(int)Math.Round(Number(action,"deltaY"));
    if(Math.Abs((long)x)>5000 || Math.Abs((long)y)>5000)
      throw new ComputerFault("computer_request_invalid","Scroll delta is out of range.");
    var inputs=new List<NativeInput>();
    if(x!=0) inputs.Add(Mouse(0x1000,0,0,unchecked((uint)x)));
    // Public deltas use positive-down screen coordinates; Windows wheel uses positive-up.
    if(y!=0) inputs.Add(Mouse(0x0800,0,0,unchecked((uint)-y)));
    VerifyInitialInputBinding(request); dispatch.Send(inputs.ToArray());
  }
  static void Drag(Dictionary<string,object> action,Dictionary<string,object> request,DispatchState dispatch) {
    Point from=InputPoint(Field(action,"from")),to=InputPoint(Field(action,"to"));
    int duration=PhysicalPixel(action,"durationMs",0,5000); string button=Text(action,"button",16);
    uint down=ButtonFlag(button,false),up=ButtonFlag(button,true);
    int steps=Math.Max(1,Math.Min(100,duration/16)); bool pressed=false;
    try {
      VerifyInitialInputBinding(request); pressed=true;
      dispatch.Send(new NativeInput[] {MoveInput(from),Mouse(down,0,0,0)});
      string active=NativeWindowBinding(GetForegroundWindow());
      for(int i=1;i<=steps;i++) {
        if(duration>0) Thread.Sleep(duration/steps);
        VerifyActionLease(request);
        if(NativeWindowBinding(GetForegroundWindow())!=active)
          throw new ComputerFault("computer_focus_changed","Focus changed during the drag.");
        var point=new Point {X=from.X+(int)Math.Round((double)(to.X-from.X)*i/steps),Y=from.Y+(int)Math.Round((double)(to.Y-from.Y)*i/steps)};
        dispatch.Send(new NativeInput[] {MoveInput(point)});
      }
    } finally { if(pressed) dispatch.Cleanup(new NativeInput[] {Mouse(up,0,0,0)}); }
  }
}
`;
