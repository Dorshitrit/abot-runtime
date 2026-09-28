import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { LINUX_COMPUTER_HELPER } from "../../computer-access/computer/linux-helper.js";

function pythonProbe(body: string): unknown {
  const program = `import sys,json\nnamespace={'__name__':'native_contract_test'}\nexec(compile(sys.stdin.read(),'computer_helper','exec'),namespace)\nexec(${JSON.stringify(body)},namespace)\n`;
  const result = spawnSync("python3", ["-c", program], {
    input: LINUX_COMPUTER_HELPER,
    encoding: "utf8",
    timeout: 10_000,
  });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

const fakeDesktop = String.raw`
events=[]
emit=lambda value:events.append(value)
session_locked=lambda:False
class FakeDesktop(X11Desktop):
    def __init__(self): self.injected=[]
    def source_binding(self): return self.inspect()['desktop']['binding']
    def focused_window_binding(self): return self.inspect().get('focusedWindow')
    def inspect(self):
        value=desktop_result('linux','test-session',{'x':0,'y':0,'width':100,'height':100},True,cap(True),cap(True),cap(True),'verified_window')
        value['focusedWindow']='window-one'
        return value
    def key(self,name): return (42,False)
    def text_keys(self,text): raise NativeFailure('linux_text_character_unmapped')
    def pointer(self,point): self.injected.append(['move',point])
    def button(self,button,down): self.injected.append(['button',button,down])
    def key_event(self,key,down): self.injected.append(['key',key,down])
    def capture(self,region): raise NativeFailure('test_capture_failure')
backend=FakeDesktop()
request={'operation':'act','desktopBinding':'test-session','expectedGeometry':{'x':0,'y':0,'width':100,'height':100},'expectedWindow':'window-one','action':{'kind':'click','point':{'x':10,'y':20},'button':'left','count':1},'deadlineEpochMs':time.time()*1000+10000}
`;

describe("Linux native computer contract", () => {
  it("parses the complete helper and refuses unmapped text before dispatch", () => {
    const result = pythonProbe(
      fakeDesktop +
        String.raw`
request['action']={'kind':'type_text','text':'שלום'}
result=operation('test',request,threading.Event())
print(json.dumps({'result':result,'injected':backend.injected,'events':events}))
`,
    );
    expect(result).toMatchObject({
      result: {
        dispatch: { status: "not_dispatched" },
        error: { code: "linux_text_character_unmapped" },
      },
      injected: [],
      events: [],
    });
  });

  it("preserves accepted input when its following screenshot fails", () => {
    const result = pythonProbe(
      fakeDesktop +
        String.raw`
result=operation('test',request,threading.Event())
print(json.dumps({'result':result,'injected':backend.injected,'events':events}))
`,
    );
    expect(result).toMatchObject({
      result: {
        dispatch: { status: "accepted", acceptedInputCount: 3 },
        error: { code: "computer_post_action_capture_failed" },
      },
      injected: [
        ["move", { x: 10, y: 20 }],
        ["button", 1, true],
        ["button", 1, false],
      ],
    });
  });

  it("rejects changed desktop, geometry and focus without input", () => {
    const result = pythonProbe(
      fakeDesktop +
        String.raw`
results=[]
for key,value in [('desktopBinding','other-session'),('expectedWindow','other-window'),('expectedGeometry',{'x':0,'y':0,'width':200,'height':100})]:
    changed=dict(request);changed[key]=value
    results.append(operation('test',changed,threading.Event())['dispatch']['status'])
print(json.dumps({'statuses':results,'injected':backend.injected}))
`,
    );
    expect(result).toEqual({
      statuses: ["not_dispatched", "not_dispatched", "not_dispatched"],
      injected: [],
    });
  });

  it("releases its held button on cancellation during a drag", () => {
    const result = pythonProbe(
      fakeDesktop +
        String.raw`
cancel=threading.Event()
old_button=backend.button
def button(button,down):
    old_button(button,down)
    if down:cancel.set()
backend.button=button
request['action']={'kind':'drag','from':{'x':10,'y':10},'to':{'x':50,'y':50},'button':'left','durationMs':0}
result=operation('test',request,cancel)
print(json.dumps({'result':result,'injected':backend.injected}))
`,
    );
    expect(result).toMatchObject({
      result: {
        dispatch: { status: "partial", reason: "computer_action_cancelled" },
      },
      injected: [
        ["move", { x: 10, y: 10 }],
        ["button", 1, true],
        ["button", 1, false],
      ],
    });
  });

  it("refuses fractional conventional wheel steps before dispatch", () => {
    const result = pythonProbe(
      fakeDesktop +
        String.raw`
request['action']={'kind':'scroll','deltaX':0,'deltaY':1}
result=operation('test',request,threading.Event())
print(json.dumps({'result':result,'injected':backend.injected}))
`,
    );
    expect(result).toMatchObject({
      result: {
        dispatch: { status: "not_dispatched" },
        error: { code: "linux_scroll_fraction_unsupported" },
      },
      injected: [],
    });
  });

  it("encodes an in-memory 8-bit RGB PNG with bounded dimensions", () => {
    const result = pythonProbe(String.raw`
png=encode_png(2,1,b'\x00\xff\x00\x00\x00\xff\x00')
print(json.dumps({'signature':list(png[:8]),'dimensions':list(struct.unpack('!II',png[16:24])),'format':list(png[24:29])}))
`);
    expect(result).toEqual({
      signature: [137, 80, 78, 71, 13, 10, 26, 10],
      dimensions: [2, 1],
      format: [8, 2, 0, 0, 0],
    });
  });

  it("counts shifted input and releases both synthetic keys", () => {
    const result = pythonProbe(
      fakeDesktop +
        String.raw`
backend.text_keys=lambda text:[(20,True)]
request['action']={'kind':'type_text','text':'A'}
result=operation('test',request,threading.Event())
print(json.dumps({'dispatch':result['dispatch'],'injected':backend.injected}))
`,
    );
    expect(result).toEqual({
      dispatch: {
        status: "accepted",
        requestedInputCount: 4,
        acceptedInputCount: 4,
      },
      injected: [
        ["key", 42, true],
        ["key", 20, true],
        ["key", 20, false],
        ["key", 42, false],
      ],
    });
  });

  it("reports Wayland grants separately from installed portal dependencies", () => {
    const result = pythonProbe(String.raw`
portal=PortalDesktop.__new__(PortalDesktop)
portal.closed=False;portal.remote_available=True;portal.capture_available=True
portal.invalidated_reason=None
portal.session=None;portal.binding='portal-pending';portal.geometry={'x':0,'y':0,'width':1,'height':1}
before=portal.inspect()
portal.session='/session/granted';portal.devices=1
after=portal.inspect()
print(json.dumps({'before':before,'after':after}))
`);
    expect(result).toMatchObject({
      before: {
        desktop: {
          targetingGuarantee: "observed_surface",
          capabilities: {
            capture: {
              supported: true,
              available: false,
              reason: "linux_portal_permission_required",
            },
            windows: { supported: false, available: false },
          },
        },
      },
      after: {
        desktop: {
          capabilities: {
            capture: { available: true },
            input: {
              available: false,
              reason: "linux_portal_input_permission_partial",
            },
          },
        },
      },
    });
  });

  it("uses portal stream identity and conventional wheel axes for physical input", () => {
    const result = pythonProbe(String.raw`
portal=PortalDesktop.__new__(PortalDesktop)
portal.stream=37
calls=[]
portal.notify=lambda method,signature,values:calls.append([method,signature,values])
portal.pointer({'x':40,'y':90})
portal.scroll(120,-240)
portal.key_event(0x10005d0,True)
print(json.dumps(calls))
`);
    expect(result).toEqual([
      ["NotifyPointerMotionAbsolute", "(oa{sv}udd)", [37, 40, 90]],
      ["NotifyPointerAxisDiscrete", "(oa{sv}ui)", [1, 1]],
      ["NotifyPointerAxisDiscrete", "(oa{sv}ui)", [0, -2]],
      ["NotifyKeyboardKeysym", "(oa{sv}iu)", [0x10005d0, 1]],
    ]);
  });

  it("closes a pending portal permission request on cancellation", () => {
    const result = pythonProbe(String.raw`
from types import SimpleNamespace
portal=PortalDesktop.__new__(PortalDesktop)
portal.GLib=SimpleNamespace(Variant=lambda signature,value:value)
portal.Gio=SimpleNamespace(DBusSignalFlags=SimpleNamespace(NONE=0))
calls=[]
portal.bus=SimpleNamespace(get_unique_name=lambda:':1.5',signal_subscribe=lambda *args:11,signal_unsubscribe=lambda token:calls.append(['unsubscribe',token]))
portal.call=lambda *args:calls.append(list(args))
cancel=threading.Event();cancel.set()
try:portal.request(portal.REMOTE,'Start','(osa{sv})',['/session/test',''],{},cancel)
except NativeFailure as error:code=error.code
print(json.dumps({'code':code,'methods':[call[1] for call in calls if len(call)>2],'unsubscribed':calls[-1]}))
`);
    expect(result).toEqual({
      code: "linux_portal_request_cancelled",
      methods: ["Start", "Close"],
      unsubscribed: ["unsubscribe", 11],
    });
  });

  it("discards cached and in-flight old portal frames before observation", () => {
    const result = pythonProbe(String.raw`
from types import SimpleNamespace
def sample(timestamp):
    return SimpleNamespace(get_buffer=lambda:SimpleNamespace(pts=timestamp),get_segment=lambda:SimpleNamespace(to_running_time=lambda format,pts:pts))
cached=iter([sample(40),None]);incoming=iter([sample(80),sample(120)])
sink=SimpleNamespace(emit=lambda name,timeout:next(cached) if timeout==0 else next(incoming))
gst=SimpleNamespace(SECOND=1000000000,CLOCK_TIME_NONE=-1,Format=SimpleNamespace(TIME=1))
pipeline=SimpleNamespace(get_clock=lambda:SimpleNamespace(get_time=lambda:200),get_base_time=lambda:100)
frame=fresh_portal_sample(SimpleNamespace(sink=sink,Gst=gst,pipeline=pipeline))
print(json.dumps({'timestamp':frame.get_buffer().pts}))
`);
    expect(result).toEqual({ timestamp: 120 });
  });

  it("refuses to assign fresh evidence when only a cached portal frame exists", () => {
    const result = pythonProbe(String.raw`
from types import SimpleNamespace
gst=SimpleNamespace(SECOND=1000000000,CLOCK_TIME_NONE=-1,Format=SimpleNamespace(TIME=1))
pipeline=SimpleNamespace(get_clock=lambda:SimpleNamespace(get_time=lambda:200),get_base_time=lambda:100)
clock=iter([0,0,1,2,4]);time.monotonic=lambda:next(clock)
try:fresh_portal_sample(SimpleNamespace(sink=SimpleNamespace(emit=lambda name,timeout:None),Gst=gst,pipeline=pipeline))
except NativeFailure as error:code=error.code
print(json.dumps({'code':code}))
`);
    expect(result).toEqual({ code: "linux_pipewire_fresh_frame_unavailable" });
  });

  it("invalidates the portal session when negotiated frame geometry changes", () => {
    const result = pythonProbe(String.raw`
from types import SimpleNamespace
portal=PortalDesktop.__new__(PortalDesktop)
portal.closed=False;portal.invalidated_reason=None;portal.capture_dimensions=(100,100)
structure=SimpleNamespace(get_value=lambda field:200 if field=='width' else 100)
caps=SimpleNamespace(get_structure=lambda index:structure)
portal.sink=SimpleNamespace(get_static_pad=lambda name:SimpleNamespace(get_current_caps=lambda:caps))
portal.validate_stream_dimensions()
print(json.dumps({'closed':portal.closed,'reason':portal.invalidated_reason}))
`);
    expect(result).toEqual({
      closed: true,
      reason: "linux_portal_geometry_changed",
    });
  });
});
