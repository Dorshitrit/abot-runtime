/** The job owns the server and every descendant before its first instruction.
 * Closing/killing this wrapper closes the job, including router model workers.
 * Only the installed executable and validated arguments arrive via the private
 * child environment. The API key stays in that environment, never the CLI.
 */
export const WINDOWS_LLAMA_JOB = String.raw`
$ErrorActionPreference = 'Stop'
$plan = ConvertFrom-Json $env:ABOT_LLAMA_COMMAND_JSON
Remove-Item Env:ABOT_LLAMA_COMMAND_JSON
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class ABotLlamaJob {
  [StructLayout(LayoutKind.Sequential)] struct IO { public ulong a,b,c,d,e,f; }
  [StructLayout(LayoutKind.Sequential)] struct Basic {
    public long user, job; public uint flags; public UIntPtr min,max;
    public uint processes; public UIntPtr affinity; public uint priority,scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct Limits {
    public Basic basic; public IO io; public UIntPtr processMemory,jobMemory,peakProcess,peakJob;
  }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup {
    public int cb; public string reserved,desktop,title; public uint x,y,xSize,ySize,xChars,yChars,fill,flags;
    public short show,reservedBytes; public IntPtr reserved2,input,output,error;
  }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo {
    public IntPtr process,thread; public uint processId,threadId;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes,string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int kind,ref Limits limits,uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string file,StringBuilder command,IntPtr processAttributes,IntPtr threadAttributes,bool inherit,uint flags,IntPtr environment,string cwd,ref Startup startup,out ProcessInfo process);
  [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint timeout);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process,uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  static string Quote(string value) {
    var result = new StringBuilder("\""); int slashes = 0;
    foreach(char c in value) {
      if(c == '\\') { slashes++; continue; }
      if(c == '"') { result.Append('\\',slashes*2+1); result.Append(c); slashes=0; continue; }
      result.Append('\\',slashes); slashes=0; result.Append(c);
    }
    result.Append('\\',slashes*2); result.Append('"'); return result.ToString();
  }
  public static int Run(string file,string[] args,string cwd) {
    IntPtr job = CreateJobObject(IntPtr.Zero,null);
    if(job == IntPtr.Zero) throw new Exception("job_create_failed");
    ProcessInfo process = new ProcessInfo();
    try {
      var limits = new Limits(); limits.basic.flags = 0x2000;
      if(!SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(limits))) throw new Exception("job_limits_failed");
      var command = new StringBuilder(Quote(file)); foreach(string arg in args) command.Append(" ").Append(Quote(arg));
      var startup = new Startup(); startup.cb = Marshal.SizeOf(startup);
      if(!CreateProcess(file,command,IntPtr.Zero,IntPtr.Zero,false,0x08000004,IntPtr.Zero,cwd,ref startup,out process)) throw new Exception("server_create_failed");
      if(!AssignProcessToJobObject(job,process.process)) { TerminateProcess(process.process,1); throw new Exception("job_assign_failed"); }
      if(ResumeThread(process.thread) == UInt32.MaxValue) throw new Exception("server_resume_failed");
      WaitForSingleObject(process.process,UInt32.MaxValue);
      uint code; if(!GetExitCodeProcess(process.process,out code)) return 1;
      return unchecked((int)code);
    } finally {
      CloseHandle(job);
      if(process.thread != IntPtr.Zero) CloseHandle(process.thread);
      if(process.process != IntPtr.Zero) CloseHandle(process.process);
    }
  }
}
'@
exit [ABotLlamaJob]::Run([string]$plan.file, [string[]]$plan.args, [string]$plan.cwd)
`;
