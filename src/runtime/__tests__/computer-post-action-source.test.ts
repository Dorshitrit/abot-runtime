import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { LINUX_COMPUTER_HELPER } from "../../computer-access/computer/linux-helper.js";

function probe(body: string): any {
  const program = `import sys,json\nnamespace={'__name__':'post_action_test'}\nexec(compile(sys.stdin.read(),'computer_helper','exec'),namespace)\nexec(${JSON.stringify(body)},namespace)\n`;
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
read_accessibility=lambda window:([],False,False)
class FakeDesktop(X11Desktop):
    def __init__(self):
        self.captures=0;self.changed=False;self.focused='window-a'
    def source_binding(self): return self.inspect()['desktop']['binding']
    def inspect(self):
        binding='replacement' if self.changed and drift=='binding' else 'approved'
        width=200 if self.changed and drift=='geometry' else 100
        value=desktop_result('linux',binding,{'x':0,'y':0,'width':width,'height':100},True,cap(True),cap(True),cap(True),'verified_window')
        value['focusedWindow']=self.focused
        value['windows']=[{'binding':name,'title':name} for name in ['window-a','window-b']]
        return value
    def pointer(self,point): self.changed=True
    def button(self,button,down):
        if fail_input: raise NativeFailure('test_input_failure')
    def focus(self,binding): self.focused=binding;self.changed=True
    def capture(self,region):
        self.captures+=1
        return (encode_png(1,1,b'\x00\xff\x00\x00'),1,1)
backend=FakeDesktop()
request={'operation':'act','desktopBinding':'approved','expectedGeometry':{'x':0,'y':0,'width':100,'height':100},'expectedWindow':'window-a','action':{'kind':'click','point':{'x':10,'y':20},'button':'left','count':1},'deadlineEpochMs':time.time()*1000+10000}
`;

function act(drift: string, failInput = false, focus = false): any {
  return probe(
    `drift=${JSON.stringify(drift)}\nfail_input=${failInput ? "True" : "False"}\n` +
      fixture +
      (focus
        ? "request['action']={'kind':'focus_window','windowBinding':'window-b'}\n"
        : "") +
      "result=operation('test',request,threading.Event())\nprint(json.dumps({'result':result,'captures':backend.captures}))",
  );
}

describe("post-action capture stays bound to the approved desktop", () => {
  it.each([
    ["binding", false],
    ["geometry", false],
    ["binding", true],
    ["geometry", true],
  ] as const)(
    "rejects %s drift after input (partial: %s)",
    (drift, partial) => {
      const { result, captures } = act(drift, partial);
      expect(result.dispatch).toMatchObject({
        status: partial ? "partial" : "accepted",
        acceptedInputCount: partial ? 1 : 3,
      });
      expect(result.error.code).toBe(
        drift === "binding"
          ? "computer_desktop_stale"
          : "computer_geometry_changed",
      );
      expect(captures).toBe(0);
      expect(result.observation).toBeUndefined();
      expect(result.imageBase64).toBeUndefined();
    },
  );

  it("captures after settled input when the approved source is unchanged", () => {
    const { result, captures } = act("none");
    expect(result.error).toBeUndefined();
    expect(result.dispatch.status).toBe("accepted");
    expect(captures).toBe(1);
    expect(result.imageBase64).toBeTruthy();
  });

  it("permits an intentional window focus change on the approved source", () => {
    const { result, captures } = act("none", false, true);
    expect(result.error).toBeUndefined();
    expect(result.focusedWindow).toBe("window-b");
    expect(result.dispatch.status).toBe("accepted");
    expect(captures).toBe(1);
  });

  it("still rejects source drift after an intentional focus change", () => {
    const { result, captures } = act("binding", false, true);
    expect(result.error.code).toBe("computer_desktop_stale");
    expect(result.dispatch).toMatchObject({
      status: "accepted",
      acceptedInputCount: 1,
    });
    expect(captures).toBe(0);
    expect(result.imageBase64).toBeUndefined();
  });
});
