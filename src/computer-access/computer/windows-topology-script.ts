/** Monitor source arrangement is part of opaque desktop identity, not a new tool field. */
export const WINDOWS_TOPOLOGY_SCRIPT = String.raw`
public static partial class AbotComputer {
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct CaptureMonitorInfo {
    public int Size; public Rect Monitor,Work; public uint Flags;
    [MarshalAs(UnmanagedType.ByValTStr,SizeConst=32)] public string Device;
  }
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct CaptureDisplayMode {
    [MarshalAs(UnmanagedType.ByValTStr,SizeConst=32)] public string DeviceName;
    public ushort SpecVersion,DriverVersion,Size,DriverExtra; public uint Fields;
    public int PositionX,PositionY; public uint Orientation,FixedOutput;
    public short Color,Duplex,YResolution,TTOption,Collate;
    [MarshalAs(UnmanagedType.ByValTStr,SizeConst=32)] public string FormName;
    public ushort LogPixels; public uint BitsPerPixel,PixelWidth,PixelHeight,DisplayFlags,Frequency;
    public uint IcmMethod,IcmIntent,MediaType,DitherType,Reserved1,Reserved2,PanningWidth,PanningHeight;
  }
  delegate bool CaptureMonitorCallback(IntPtr monitor,IntPtr dc,ref Rect bounds,IntPtr data);
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct CaptureDisplayDevice {
    public int Size;
    [MarshalAs(UnmanagedType.ByValTStr,SizeConst=32)] public string Name;
    [MarshalAs(UnmanagedType.ByValTStr,SizeConst=128)] public string Description;
    public uint Flags;
    [MarshalAs(UnmanagedType.ByValTStr,SizeConst=128)] public string InterfaceId;
    [MarshalAs(UnmanagedType.ByValTStr,SizeConst=128)] public string RegistryKey;
  }
  [DllImport("user32.dll")] static extern bool EnumDisplayMonitors(IntPtr dc,IntPtr clip,CaptureMonitorCallback callback,IntPtr data);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern bool GetMonitorInfo(IntPtr monitor,ref CaptureMonitorInfo info);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern bool EnumDisplaySettingsEx(string device,int mode,ref CaptureDisplayMode settings,uint flags);
  [DllImport("shcore.dll")] static extern int GetScaleFactorForMonitor(IntPtr monitor,out int scale);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern bool EnumDisplayDevices(string device,uint index,ref CaptureDisplayDevice info,uint flags);

  static bool TryMonitorScale(IntPtr monitor,out int scale) {
    scale=0;
    try { return GetScaleFactorForMonitor(monitor,out scale)==0; }
    catch(DllNotFoundException) { return false; }
    catch(EntryPointNotFoundException) { return false; }
  }

  static string SourceFingerprint(List<string> records) {
    records.Sort(StringComparer.Ordinal);
    using(var hash=System.Security.Cryptography.SHA256.Create()) {
      return BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(Json.Serialize(records)))).Replace("-","").ToLowerInvariant();
    }
  }
  static string MonitorSourceIds(string device) {
    var sources=new List<string>();
    for(uint index=0;index<128;index++) {
      var info=new CaptureDisplayDevice { Size=Marshal.SizeOf(typeof(CaptureDisplayDevice)) };
      if(!EnumDisplayDevices(device,index,ref info,1)) break;
      if((info.Flags&1)==0) continue;
      if(String.IsNullOrEmpty(info.InterfaceId)) return null;
      sources.Add(info.InterfaceId);
    }
    if(sources.Count==0) return null;
    return SourceFingerprint(sources);
  }
  static string ReadCaptureTopology() {
    var records=new List<string>(); bool queryFailed=false;
    CaptureMonitorCallback callback=delegate(IntPtr monitor,IntPtr dc,ref Rect bounds,IntPtr data) {
      if(records.Count>=128) { queryFailed=true; return false; }
      var info=new CaptureMonitorInfo { Size=Marshal.SizeOf(typeof(CaptureMonitorInfo)) };
      if(!GetMonitorInfo(monitor,ref info)) { queryFailed=true; return false; }
      var mode=new CaptureDisplayMode { Size=(ushort)Marshal.SizeOf(typeof(CaptureDisplayMode)) };
      if(!EnumDisplaySettingsEx(info.Device,-1,ref mode,0)) { queryFailed=true; return false; }
      int scale;
      if(!TryMonitorScale(monitor,out scale)) { queryFailed=true; return false; }
      string sources=MonitorSourceIds(info.Device);
      if(sources==null) { queryFailed=true; return false; }
      records.Add(Json.Serialize(new object[] {info.Device,monitor.ToInt64(),info.Monitor.Left,info.Monitor.Top,
        info.Monitor.Right,info.Monitor.Bottom,info.Flags,mode.Orientation,mode.FixedOutput,
        mode.PixelWidth,mode.PixelHeight,mode.PositionX,mode.PositionY,scale,sources}));
      return true;
    };
    bool complete=EnumDisplayMonitors(IntPtr.Zero,IntPtr.Zero,callback,IntPtr.Zero);
    if(!complete || queryFailed || records.Count==0)
      throw new ComputerFault("computer_topology_unavailable","The monitor source arrangement could not be verified.");
    return SourceFingerprint(records);
  }
}
`;
