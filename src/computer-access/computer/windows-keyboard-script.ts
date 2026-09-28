/** Explicit key mapping and Unicode injection, with release records for partial dispatch. */
export const WINDOWS_KEYBOARD_SCRIPT = String.raw`
public static partial class AbotComputer {
  static ushort VirtualKey(string name) {
    string key=name.Trim().ToUpperInvariant();
    if(key.Length==1 && ((key[0]>='A' && key[0]<='Z') || (key[0]>='0' && key[0]<='9'))) return key[0];
    int function;
    if(key.StartsWith("F") && Int32.TryParse(key.Substring(1),out function) && function>=1 && function<=24)
      return (ushort)(111+function);
    switch(key) {
      case "CONTROL": case "CTRL": return 17;
      case "ALT": case "OPTION": return 18;
      case "SHIFT": return 16;
      case "META": case "WIN": case "WINDOWS": case "SUPER": return 91;
      case "ENTER": case "RETURN": return 13;
      case "TAB": return 9;
      case "ESC": case "ESCAPE": return 27;
      case "BACKSPACE": return 8;
      case "DELETE": case "DEL": return 46;
      case "SPACE": return 32;
      case "LEFT": case "ARROWLEFT": return 37;
      case "UP": case "ARROWUP": return 38;
      case "RIGHT": case "ARROWRIGHT": return 39;
      case "DOWN": case "ARROWDOWN": return 40;
      case "HOME": return 36;
      case "END": return 35;
      case "PAGEUP": case "PGUP": return 33;
      case "PAGEDOWN": case "PGDN": return 34;
      case "INSERT": case "INS": return 45;
      case "CAPSLOCK": return 20;
      case "PRINTSCREEN": return 44;
      default: throw new ComputerFault("computer_key_unsupported","Use explicit supported key names; text belongs in type_text.");
    }
  }
  static bool IsExtendedKey(ushort key) {
    if(key>=33 && key<=46) return true;
    return key==91;
  }
  static NativeInput Key(ushort key,ushort scan,uint flags) {
    return new NativeInput {Type=1,Data=new InputUnion {Keyboard=new KeyboardInput {Key=key,Scan=scan,Flags=flags}}};
  }
  static void PressKeys(Dictionary<string,object> action,Dictionary<string,object> request,DispatchState dispatch) {
    var raw=Field(action,"keys") as object[];
    if(raw==null || raw.Length<1 || raw.Length>8)
      throw new ComputerFault("computer_request_invalid","Use one to eight explicit keys.");
    var keys=new List<ushort>(); var seen=new HashSet<ushort>();
    foreach(object value in raw) {
      var text=value as string;
      if(text==null || text.Length>32) throw new ComputerFault("computer_request_invalid","Invalid key name.");
      ushort key=VirtualKey(text);
      if(!seen.Add(key)) throw new ComputerFault("computer_request_invalid","A chord cannot repeat the same key.");
      if((GetAsyncKeyState(key)&0x8000)!=0)
        throw new ComputerFault("computer_user_input_active","A requested key is already physically held.");
      keys.Add(key);
    }
    var inputs=new List<NativeInput>(); var releases=new List<NativeInput>();
    foreach(ushort key in keys) inputs.Add(Key(key,0,IsExtendedKey(key)?1u:0u));
    for(int i=keys.Count-1;i>=0;i--) releases.Add(Key(keys[i],0,2u|(IsExtendedKey(keys[i])?1u:0u)));
    inputs.AddRange(releases); VerifyInitialInputBinding(request);
    try { dispatch.Send(inputs.ToArray()); }
    catch { dispatch.Cleanup(releases.ToArray()); throw; }
  }
  static void TypeText(Dictionary<string,object> action,Dictionary<string,object> request,DispatchState dispatch) {
    string text=Text(action,"text",4096);
    VerifyInitialInputBinding(request);
    string foreground=NativeWindowBinding(GetForegroundWindow());
    for(int start=0;start<text.Length;start+=128) {
      VerifyActionLease(request);
      if(NativeWindowBinding(GetForegroundWindow())!=foreground)
        throw new ComputerFault("computer_focus_changed","Focus changed during Unicode text input.");
      var inputs=new List<NativeInput>(); var releases=new List<NativeInput>();
      int end=Math.Min(start+128,text.Length);
      for(int i=start;i<end;i++) {
        inputs.Add(Key(0,text[i],4)); inputs.Add(Key(0,text[i],6)); releases.Add(Key(0,text[i],6));
      }
      try { dispatch.Send(inputs.ToArray()); }
      catch { dispatch.Cleanup(releases.ToArray()); throw; }
    }
  }
}
`;
