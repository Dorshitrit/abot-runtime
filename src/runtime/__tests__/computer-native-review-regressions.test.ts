import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { LINUX_COMPUTER_HELPER } from "../../computer-access/computer/linux-helper.js";
import { readUnixNativeResult } from "../../computer-access/computer/unix-native-results.js";
import { projectComputerResult } from "../../../plugins/system/source/computer/observation-result.js";
import { DesktopBindings } from "../../../plugins/system/source/computer/desktop-bindings.js";
import { computerRoute } from "./computer-plugin-fixtures.js";

function nativeProbe(body: string): any {
  const program = `import sys,json\nnamespace={'__name__':'native_review_test'}\nexec(compile(sys.stdin.read(),'computer_helper','exec'),namespace)\nexec(${JSON.stringify(body)},namespace)\n`;
  const result = spawnSync("python3", ["-c", program], {
    input: LINUX_COMPUTER_HELPER,
    encoding: "utf8",
    timeout: 10_000,
  });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

const nativeFixture = String.raw`
emit=lambda value:None
session_locked=lambda:False
class FakeDesktop(X11Desktop):
    def __init__(self): self.captures=0
    def source_binding(self): return self.inspect()['desktop']['binding']
    def inspect(self):
        value=desktop_result('linux','current-session',{'x':0,'y':0,'width':100,'height':100},True,cap(True),cap(True),cap(True),'observed_surface')
        return value
    def pointer(self,point): pass
    def button(self,button,down): pass
    def capture(self,region):
        self.captures+=1
        return (encode_png(1,1,b'\x00\xff\x00\x00'),1,1)
backend=FakeDesktop()
request={'operation':'act','desktopBinding':'current-session','expectedGeometry':{'x':0,'y':0,'width':100,'height':100},'action':{'kind':'click','point':{'x':10,'y':20},'button':'left','count':1},'deadlineEpochMs':time.time()*1000+10000}
`;

describe("native PR91 review invariants", () => {
  it.each(["partial", "unknown"])(
    "returns an error with a %s receipt even when fresh capture succeeds",
    async (status) => {
      const result = nativeProbe(
        nativeFixture +
          (status === "partial"
            ? "backend.button=lambda *args:(_ for _ in ()).throw(NativeFailure('test_injection_failed'))\n"
            : "backend.pointer=lambda *args:(_ for _ in ()).throw(NativeFailure('test_injection_failed'))\n") +
          "print(json.dumps(operation('test',request,threading.Event())))",
      );
      expect(result.dispatch).toMatchObject({
        status,
        reason: "test_injection_failed",
      });
      expect(result.error?.code).toBe(`computer_input_${status}`);
      expect(result.observation).toMatchObject({
        imageWidth: 1,
        imageHeight: 1,
      });
      expect(result.imageBase64).toBeTruthy();
      const projected = await projectComputerResult(
        {
          ref: "desktop",
          route: computerRoute,
          bindings: new DesktopBindings(),
        },
        readUnixNativeResult(result, "linux"),
        {
          media: {
            writeImage: async () => ({
              kind: "tool_image_v1",
              id: "image",
              mimeType: "image/png",
              size: 1,
              width: 1,
              height: 1,
              sha256: "0".repeat(64),
            }),
          },
        },
      );
      expect(projected.ok).toBe(false);
      expect(projected.data?.dispatch).toMatchObject({ status });
      expect(projected.data?.observation_ref).toBeTruthy();
      expect(projected.media).toHaveLength(1);
    },
  );

  it.each(["desktopBinding", "expectedGeometry"])(
    "rejects regional observation %s drift before reading pixels",
    (field) => {
      const result = nativeProbe(
        nativeFixture +
          String.raw`
request['operation']='observe'
request['region']={'x':10,'y':10,'width':20,'height':20}
` +
          (field === "desktopBinding"
            ? "request['desktopBinding']='previous-session'\n"
            : "request['expectedGeometry']={'x':-100,'y':0,'width':200,'height':100}\n") +
          "result=operation('test',request,threading.Event())\nprint(json.dumps({'result':result,'captures':backend.captures}))",
      );
      expect(result.result.error?.code).toBe(
        field === "desktopBinding"
          ? "computer_desktop_stale"
          : "computer_geometry_changed",
      );
      expect(result.captures).toBe(0);
      expect(result.result.observation).toBeUndefined();
    },
  );

  it("captures a bound region when its source desktop remains current", () => {
    const result = nativeProbe(
      nativeFixture +
        String.raw`
request['operation']='observe'
request['region']={'x':10,'y':10,'width':20,'height':20}
result=operation('test',request,threading.Event())
print(json.dumps({'result':result,'captures':backend.captures}))
`,
    );
    expect(result.captures).toBe(1);
    expect(result.result.error).toBeUndefined();
    expect(result.result.observation.region).toEqual({
      x: 10,
      y: 10,
      width: 20,
      height: 20,
    });
  });

  it.each(["missing", "outside_inventory", "bound"])(
    "advertises only the focus guarantee established by %s inventory",
    (mode) => {
      const result = nativeProbe(String.raw`
native=X11Desktop.__new__(X11Desktop)
native.root=1;native.binding='test-session';native.t=None
native.source_binding=lambda:'test-session'
native.geometry=lambda xid:{'x':0,'y':0,'width':100,'height':100}
mode=${JSON.stringify(mode)}
active={'bound':2,'outside_inventory':68,'missing':100}[mode]
ids=[2] if mode!='outside_inventory' else list(range(2,70))
native.property=lambda window,name:([active] if name=='_NET_ACTIVE_WINDOW' else ids if name in ['_NET_CLIENT_LIST','_NET_CLIENT_LIST_STACKING'] else [5] if name=='_NET_WM_PID' else '')
print(json.dumps(native.inspect()))
`);
      expect(result.desktop.targetingGuarantee).toBe(
        mode === "bound" ? "verified_window" : "observed_surface",
      );
      expect(Boolean(result.focusedWindow)).toBe(mode === "bound");
    },
  );
});
