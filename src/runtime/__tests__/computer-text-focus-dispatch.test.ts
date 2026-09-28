import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { LINUX_COMPUTER_HELPER } from "../../computer-access/computer/linux-helper.js";

function probe(body: string): any {
  const program = `import sys,json\nnamespace={'__name__':'text_focus_test'}\nexec(compile(sys.stdin.read(),'computer_helper','exec'),namespace)\nexec(${JSON.stringify(body)},namespace)\n`;
  const result = spawnSync("python3", ["-c", program], {
    input: LINUX_COMPUTER_HELPER,
    encoding: "utf8",
    timeout: 10_000,
  });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

const fixture = String.raw`
emit=lambda value:None
session_locked=lambda:False
class TextDesktop(X11Desktop):
    def __init__(self):
        self.focus='11:22';self.events=[];self.held=[];self.focus_reads=0;self.inventory_reads=0
    def source_binding(self):return 'desktop'
    def focused_window_binding(self):
        self.focus_reads+=1
        return self.focus
    def inspect(self):
        self.inventory_reads+=1
        state=desktop_result('linux','desktop',{'x':0,'y':0,'width':10,'height':10},True,cap(True),cap(True),cap(True),'verified_window')
        state['focusedWindow']=self.focus
        return state
    def key(self,name):return (42,False)
    def text_keys(self,text):return [(20,False),(21,False)]
    def key_event(self,key,down):
        self.events.append([key,down])
        if down:self.held.append(key)
        else:self.held.remove(key)
        if mode=='between_characters' and key==20 and not down:self.focus='33:44'
        if mode=='held_modifier' and key==42 and down:self.focus='33:44'
    def capture(self,region):return (encode_png(1,1,b'\x00\xff\x00\x00'),1,1)
backend=TextDesktop()
request={'operation':'act','desktopBinding':'desktop','expectedGeometry':{'x':0,'y':0,'width':10,'height':10},'expectedWindow':'11:22','action':{'kind':'type_text','text':'ab'},'deadlineEpochMs':time.time()*1000+10000}
`;

describe("verified text focus during native dispatch", () => {
  it("stops before the next character when focused window changes", () => {
    const result = probe(
      fixture +
        String.raw`
mode='between_characters'
result=operation('test',request,threading.Event())
print(json.dumps({'result':result,'events':backend.events,'held':backend.held,'inventory':backend.inventory_reads}))
`,
    );
    expect(result.result.dispatch).toMatchObject({
      status: "partial",
      acceptedInputCount: 2,
      requestedInputCount: 4,
      reason: "computer_focus_changed",
    });
    expect(result.result.error.code).toBe("computer_input_partial");
    expect(result.events).toEqual([
      [20, true],
      [20, false],
    ]);
    expect(result.held).toEqual([]);
    expect(result.inventory).toBeLessThanOrEqual(4);
  });

  it("releases its held modifier after focus changes before the text key", () => {
    const result = probe(
      fixture +
        String.raw`
mode='held_modifier'
backend.text_keys=lambda text:[(20,True),(21,False)]
result=operation('test',request,threading.Event())
print(json.dumps({'result':result,'events':backend.events,'held':backend.held}))
`,
    );
    expect(result.result.dispatch).toMatchObject({
      status: "partial",
      acceptedInputCount: 1,
      reason: "computer_focus_changed",
    });
    expect(result.events).toEqual([
      [42, true],
      [42, false],
    ]);
    expect(result.held).toEqual([]);
  });

  it("keeps stable-focus text and unverified-surface behavior unchanged", () => {
    const result = probe(
      fixture +
        String.raw`
mode='stable'
stable=operation('test',request,threading.Event())
backend.events=[];backend.focus_reads=0
request.pop('expectedWindow')
unverified=operation('test',request,threading.Event())
print(json.dumps({'stable':stable['dispatch'],'unverified':unverified['dispatch'],'focusReads':backend.focus_reads,'events':backend.events}))
`,
    );
    expect(result.stable).toMatchObject({
      status: "accepted",
      acceptedInputCount: 4,
    });
    expect(result.unverified).toEqual(result.stable);
    expect(result.focusReads).toBe(0);
    expect(result.events).toHaveLength(4);
  });

  it("reads only X11 active-window identity and its PID", () => {
    const result = probe(String.raw`
desktop=X11Desktop.__new__(X11Desktop);desktop.root=1
calls=[]
def property(window,name):
    calls.append([window,name])
    return [11] if name=='_NET_ACTIVE_WINDOW' else [22]
desktop.property=property
print(json.dumps({'binding':desktop.focused_window_binding(),'calls':calls}))
`);
    expect(result).toEqual({
      binding: "11:22",
      calls: [
        [1, "_NET_ACTIVE_WINDOW"],
        [11, "_NET_WM_PID"],
      ],
    });
  });
});
