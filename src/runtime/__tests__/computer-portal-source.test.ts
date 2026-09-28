import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { LINUX_COMPUTER_HELPER } from "../../computer-access/computer/linux-helper.js";

function probe(body: string): any {
  const program = `import sys,json\nnamespace={'__name__':'portal_source_test'}\nexec(compile(sys.stdin.read(),'computer_helper','exec'),namespace)\nexec(${JSON.stringify(body)},namespace)\n`;
  const result = spawnSync("python3", ["-c", program], {
    input: LINUX_COMPUTER_HELPER,
    encoding: "utf8",
    timeout: 10_000,
  });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

it("pins the portal source serial and rejects a reused node's different source identity", () => {
  const result = probe(String.raw`
from types import SimpleNamespace
calls=[]
source=SimpleNamespace(find_property=lambda name:True,set_property=lambda *args:calls.append(list(args)))
backend=SimpleNamespace(stream=30,session='/session/one',geometry={'x':0,'y':0,'width':100,'height':100},Gst=SimpleNamespace(util_set_object_arg=lambda source,name,value:calls.append([name,value])))
first=bind_portal_capture_source(backend,source,{'pipewire-serial':50,'id':'monitor-a','size':[100,100]})
second=bind_portal_capture_source(backend,source,{'pipewire-serial':51,'id':'monitor-b','size':[100,100]})
print(json.dumps({'first':first,'second':second,'calls':calls}))
`);
  expect(result.first).not.toBe(result.second);
  expect(result.calls).toContainEqual(["target-object", "50"]);
  expect(result.calls).toContainEqual(["on-disconnect", "error"]);
});

it("keeps a legacy non-reconnecting stream without optional on-disconnect", () => {
  const result = probe(String.raw`
from types import SimpleNamespace
calls=[]
source=SimpleNamespace(find_property=lambda name:False,set_property=lambda *args:calls.append(list(args)))
backend=SimpleNamespace(stream=30,session='/session/legacy',geometry={'x':0,'y':0,'width':100,'height':100})
binding=bind_portal_capture_source(backend,source,{})
print(json.dumps({'binding':binding,'calls':calls}))
`);
  expect(result.binding).toMatch(/^wayland:[a-f0-9]{64}$/);
  expect(result.calls).toEqual([["path", "30"]]);
});

it("accepts stable serial targeting on older PipeWire without on-disconnect", () => {
  const result = probe(String.raw`
from types import SimpleNamespace
source=SimpleNamespace(find_property=lambda name:name=='target-object',set_property=lambda *args:None)
backend=SimpleNamespace(stream=30,session='/session/one',geometry={'x':0,'y':0,'width':100,'height':100})
print(json.dumps({'binding':bind_portal_capture_source(backend,source,{'pipewire-serial':50})}))
`);
  expect(result.binding).toMatch(/^wayland:[a-f0-9]{64}$/);
});

it("invalidates same-size negotiated scale changes and terminal stream loss", () => {
  const result = probe(String.raw`
from types import SimpleNamespace
fields={'width':100,'height':100,'format':'RGB','pixel-aspect-ratio':'1/1'}
structure=SimpleNamespace(get_value=lambda key:fields.get(key),has_field=lambda key:key in fields)
caps=SimpleNamespace(get_structure=lambda index:structure)
backend=SimpleNamespace(closed=False,capture_layout=portal_frame_layout(caps))
fields['pixel-aspect-ratio']='2/1'
require_portal_frame_layout(backend,caps)
scaled=backend.closed
backend.closed=False;backend.Gst=SimpleNamespace(MessageType=SimpleNamespace(ERROR=1,EOS=2,TAG=4))
backend.pipeline=SimpleNamespace(get_bus=lambda:SimpleNamespace(pop_filtered=lambda types:SimpleNamespace(type=1)))
require_portal_stream_alive(backend)
print(json.dumps({'scaled':scaled,'closed':backend.closed,'reason':backend.invalidated_reason}))
`);
  expect(result).toEqual({
    scaled: true,
    closed: true,
    reason: "linux_portal_source_changed",
  });
});

it("invalidates same-size orientation changes carried by stream tags", () => {
  const result = probe(String.raw`
from types import SimpleNamespace
backend=SimpleNamespace(closed=False,capture_layout=('100','100','RGB'),source_orientation='rotate-0')
require_portal_orientation(backend,'rotate-180')
print(json.dumps({'closed':backend.closed,'reason':backend.invalidated_reason}))
`);
  expect(result).toEqual({
    closed: true,
    reason: "linux_portal_geometry_changed",
  });
});

it("fails closed when the bounded stream-status drain cannot reach a queued terminal event", () => {
  const result = probe(String.raw`
from types import SimpleNamespace
tag=SimpleNamespace(type=4,parse_tag=lambda:SimpleNamespace(get_string=lambda name:(False,None)))
messages=[tag]*64+[SimpleNamespace(type=1)]
backend=SimpleNamespace(closed=False,Gst=SimpleNamespace(MessageType=SimpleNamespace(ERROR=1,EOS=2,TAG=4)))
backend.pipeline=SimpleNamespace(get_bus=lambda:SimpleNamespace(pop_filtered=lambda types:messages.pop(0) if messages else None))
require_portal_stream_alive(backend)
print(json.dumps({'closed':backend.closed,'reason':getattr(backend,'invalidated_reason',None),'remaining':len(messages)}))
`);
  expect(result).toEqual({
    closed: true,
    reason: "linux_portal_source_status_unavailable",
    remaining: 1,
  });
});

const capturingPortal = String.raw`
from types import SimpleNamespace
emit=lambda value:None
session_locked=lambda:False
messages=[]
class FakePortal(PortalDesktop):
    def __init__(self):
        self.closed=False;self.remote_available=True;self.capture_available=True
        self.invalidated_reason=None;self.session='/session/test';self.binding='portal-source'
        self.geometry={'x':0,'y':0,'width':1,'height':1};self.devices=3;self.sink=None
        self.capture_dimensions=(1,1);self.capture_layout=('1','1','RGB');self.source_orientation='rotate-0'
        self.Gst=SimpleNamespace(MessageType=SimpleNamespace(ERROR=1,EOS=2,TAG=4))
        self.pipeline=SimpleNamespace(get_bus=lambda:SimpleNamespace(pop_filtered=lambda kinds:messages.pop(0) if messages else None))
    def ensure_session(self,cancel):pass
    def pointer(self,point):pass
    def button(self,button,down):pass
    def capture(self,region):
        messages.append(event)
        return (encode_png(1,1,b'\x00\xff\x00\x00'),1,1)
backend=FakePortal()
`;

it.each(["ERROR", "EOS", "TAG"])(
  "rejects %s arriving during capture and retains settled input",
  (kind) => {
    const result = probe(
      capturingPortal +
        String.raw`
event=SimpleNamespace(type=backend.Gst.MessageType.${kind},parse_tag=lambda:SimpleNamespace(get_string=lambda name:(True,'rotate-180')))
request={'operation':'act','desktopBinding':backend.binding,'expectedGeometry':backend.geometry,'action':{'kind':'click','point':{'x':0,'y':0},'button':'left','count':1},'deadlineEpochMs':time.time()*1000+10000}
print(json.dumps(operation('test',request,threading.Event())))
`,
    );
    expect(result.dispatch).toMatchObject({
      status: "accepted",
      acceptedInputCount: 3,
    });
    expect(result.error.code).toBe("computer_post_action_capture_failed");
    expect(result.desktop.available).toBe(false);
    expect(result.observation).toBeUndefined();
    expect(result.imageBase64).toBeUndefined();
  },
);

it("uses the first frame's pending orientation tag as its baseline", () => {
  const result = probe(
    capturingPortal +
      String.raw`
backend.capture_layout=None;backend.capture_dimensions=None;backend.source_orientation=None
fields={'width':1,'height':1,'format':'RGB'}
structure=SimpleNamespace(get_value=lambda key:fields.get(key),has_field=lambda key:key in fields)
caps=SimpleNamespace(get_structure=lambda index:structure)
backend.sink=SimpleNamespace(get_static_pad=lambda name:SimpleNamespace(get_current_caps=lambda:caps))
backend.Gst.MapFlags=SimpleNamespace(READ=1)
backend.GstVideo=SimpleNamespace(VideoInfo=SimpleNamespace(new_from_caps=lambda caps:SimpleNamespace(offset=[0],stride=[3])))
buffer=SimpleNamespace(map=lambda flags:(True,SimpleNamespace(data=b'\xff\x00\x00')),unmap=lambda data:None)
sample=SimpleNamespace(get_caps=lambda:caps,get_buffer=lambda:buffer)
def fresh(backend):
    messages.append(SimpleNamespace(type=4,parse_tag=lambda:SimpleNamespace(get_string=lambda name:(True,'rotate-180'))))
    return sample
fresh_portal_sample=fresh
PortalDesktop.capture(backend,backend.geometry)
backend.inspect()
print(json.dumps({'closed':backend.closed,'orientation':backend.source_orientation,'layout':backend.capture_layout}))
`,
  );
  expect(result.closed).toBe(false);
  expect(result.orientation).toBe("rotate-180");
  expect(result.layout).toBeTruthy();
});

it("accepts a delayed first orientation tag and rejects only a later change", () => {
  const result = probe(
    capturingPortal +
      String.raw`
backend.source_orientation=None
def inspect_tag(value):
    messages.append(SimpleNamespace(type=4,parse_tag=lambda:SimpleNamespace(get_string=lambda name:(True,value))))
    return backend.inspect()['desktop']['available']
first=inspect_tag('rotate-180')
repeated=inspect_tag('rotate-180')
changed=inspect_tag('rotate-0')
print(json.dumps({'first':first,'repeated':repeated,'changed':changed,'reason':backend.invalidated_reason}))
`,
  );
  expect(result).toEqual({
    first: true,
    repeated: true,
    changed: false,
    reason: "linux_portal_geometry_changed",
  });
});
