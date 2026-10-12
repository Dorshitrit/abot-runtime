/** The shell owns the sole non-inherited job handle; closing it ends its descendants. */
export const WINDOWS_EXEC_JOB_SOURCE = String.raw`
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class AbotExecJob {
  private static IntPtr job = IntPtr.Zero;

  [StructLayout(LayoutKind.Sequential)]
  private struct BasicLimits {
    public long PerProcessUserTimeLimit;
    public long PerJobUserTimeLimit;
    public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize;
    public UIntPtr MaximumWorkingSetSize;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass;
    public uint SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)]
  private struct IoCounters {
    public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
    public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
  }
  [StructLayout(LayoutKind.Sequential)]
  private struct ExtendedLimits {
    public BasicLimits BasicLimitInformation;
    public IoCounters IoInfo;
    public UIntPtr ProcessMemoryLimit, JobMemoryLimit;
    public UIntPtr PeakProcessMemoryUsed, PeakJobMemoryUsed;
  }

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool SetInformationJobObject(IntPtr handle, int kind,
    ref ExtendedLimits limits, uint size);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool AssignProcessToJobObject(IntPtr handle, IntPtr process);
  [DllImport("kernel32.dll")]
  private static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")]
  private static extern bool CloseHandle(IntPtr handle);

  public static void Attach() {
    if (job != IntPtr.Zero) throw new InvalidOperationException("Already attached");
    IntPtr candidate = CreateJobObject(IntPtr.Zero, null);
    if (candidate == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    try {
      ExtendedLimits limits = new ExtendedLimits();
      limits.BasicLimitInformation.LimitFlags = 0x00002000; // KILL_ON_JOB_CLOSE
      if (!SetInformationJobObject(candidate, 9, ref limits,
          (uint)Marshal.SizeOf(typeof(ExtendedLimits))))
        throw new Win32Exception(Marshal.GetLastWin32Error());
      if (!AssignProcessToJobObject(candidate, GetCurrentProcess()))
        throw new Win32Exception(Marshal.GetLastWin32Error());
      job = candidate;
      candidate = IntPtr.Zero;
    } finally {
      if (candidate != IntPtr.Zero) CloseHandle(candidate);
    }
  }
}
`;
