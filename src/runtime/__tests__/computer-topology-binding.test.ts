import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { LINUX_COMPUTER_HELPER } from "../../computer-access/computer/linux-helper.js";

function probe(body: string): any {
  const program = `import sys,json\nnamespace={'__name__':'topology_test'}\nexec(compile(sys.stdin.read(),'computer_helper','exec'),namespace)\nexec(${JSON.stringify(body)},namespace)\n`;
  const result = spawnSync("python3", ["-c", program], {
    input: LINUX_COMPUTER_HELPER,
    encoding: "utf8",
    timeout: 10_000,
  });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

const desktop = String.raw`
from types import SimpleNamespace
emit=lambda value:None
session_locked=lambda:False
sources=[{'id':1,'rect':[0,0,100,100],'scale':1},{'id':2,'rect':[100,0,100,100],'scale':1}]
backend=X11Desktop.__new__(X11Desktop)
backend.root=1;backend.binding='session';backend.t=object()
backend.geometry=lambda window:{'x':0,'y':0,'width':200,'height':100}
backend.property=lambda window,name:None
backend.topology=SimpleNamespace(fingerprint=lambda:source_fingerprint(sources))
effects=[]
backend.pointer=lambda point:effects.append('input')
backend.button=lambda *args:effects.append('input')
def capture(region):
    effects.append('capture')
    return (encode_png(1,1,b'\x00\xff\x00\x00'),1,1)
backend.capture=capture
state=backend.inspect()
request={'operation':'observe','region':{'x':10,'y':10,'width':20,'height':20},'desktopBinding':state['desktop']['binding'],'expectedGeometry':state['desktop']['bounds']}
`;

describe("capture-source topology identity", () => {
  it.each(["observe", "act"])(
    "rejects same-union monitor rearrangement before %s",
    (operation) => {
      const result = probe(
        desktop +
          String.raw`
request['operation']=${JSON.stringify(operation)}
if request['operation']=='act':
    request['action']={'kind':'click','point':{'x':10,'y':10},'button':'left','count':1}
    request['deadlineEpochMs']=time.time()*1000+10000
sources[0]['rect'],sources[1]['rect']=sources[1]['rect'],sources[0]['rect']
result=operation('test',request,threading.Event())
print(json.dumps({'result':result,'effects':effects,'sameBounds':state['desktop']['bounds']==backend.inspect()['desktop']['bounds']}))
`,
      );
      expect(result.sameBounds).toBe(true);
      expect(result.result.error.code).toBe("computer_desktop_stale");
      expect(result.effects).toEqual([]);
      expect(result.result.imageBase64).toBeUndefined();
    },
  );

  it("accepts unchanged sources in reordered enumeration and rejects scale/source changes", () => {
    const result = probe(
      desktop +
        String.raw`
original=backend.source_binding()
sources.reverse()
reordered=backend.source_binding()
stable=operation('test',request,threading.Event())
sources[0]['scale']=2
scaled=backend.source_binding()
sources[0]['scale']=1;sources[0]['id']=99
replaced=backend.source_binding()
print(json.dumps({'original':original,'reordered':reordered,'scaled':scaled,'replaced':replaced,'captured':bool(stable.get('observation'))}))
`,
    );
    expect(result.original).toBe(result.reordered);
    expect(result.scaled).not.toBe(result.original);
    expect(result.replaced).not.toBe(result.original);
    expect(result.captured).toBe(true);
    expect(result.original.length).toBeLessThan(4096);
  });

  it.each(["before", "during"])(
    "rejects source drift %s capture without admitting pixels",
    (when) => {
      const result = probe(
        desktop +
          String.raw`
when=${JSON.stringify(when)}
if when=='before':sources[0]['scale']=2
if when=='during':
    original_capture=backend.capture
    def changed_capture(region):
        image=original_capture(region)
        sources[0]['scale']=2
        return image
    backend.capture=changed_capture
try:add_observation(backend,state,request['region'])
except NativeFailure as error:code=error.code
print(json.dumps({'code':code,'effects':effects,'admitted':bool(state.get('imageBase64'))}))
`,
      );
      expect(result.admitted).toBe(false);
      expect(result.effects).toEqual(when === "before" ? [] : ["capture"]);
      expect(result.code).toBe(
        when === "before"
          ? "computer_desktop_stale"
          : "computer_geometry_changed_during_capture",
      );
    },
  );

  it("fails closed when RandR cannot supply a capture arrangement", () => {
    const result = probe(String.raw`
from types import SimpleNamespace
topology=X11Topology.__new__(X11Topology)
topology.desktop=SimpleNamespace(display=1,root=1)
topology.r=SimpleNamespace(XRRGetScreenResourcesCurrent=lambda *args:None)
try:topology.fingerprint()
except NativeFailure as error:code=error.code
print(json.dumps({'code':code}))
`);
    expect(result.code).toBe("linux_randr_topology_unavailable");
  });

  it("reads actual RandR CRTC output, rotation and transform fields into the fingerprint", () => {
    const result = probe(String.raw`
from types import SimpleNamespace
ids=(ctypes.c_ulong*1)(11);outputs=(ctypes.c_ulong*1)(22)
resource=RandrResources(timestamp=5,configTimestamp=6,ncrtc=1,crtcs=ids)
crtc=RandrCrtc(x=0,y=0,width=100,height=100,mode=7,rotation=1,noutput=1,outputs=outputs)
transform=RandrTransform();transform.current[:]=[65536,0,0,0,65536,0,0,0,65536]
def read_transform(display,identifier,output):
    ctypes.cast(output,ctypes.POINTER(ctypes.POINTER(RandrTransform)))[0]=ctypes.pointer(transform)
    return 1
topology=X11Topology.__new__(X11Topology)
topology.desktop=SimpleNamespace(display=1,root=1,x=SimpleNamespace(XFree=lambda *args:None))
topology.r=SimpleNamespace(XRRGetScreenResourcesCurrent=lambda *args:ctypes.pointer(resource),XRRFreeScreenResources=lambda *args:None,XRRGetCrtcInfo=lambda *args:ctypes.pointer(crtc),XRRFreeCrtcInfo=lambda *args:None,XRRGetCrtcTransform=read_transform)
original=topology.fingerprint();crtc.rotation=2;rotated=topology.fingerprint()
crtc.rotation=1;transform.current[0]=131072;scaled=topology.fingerprint()
transform.current[0]=65536;outputs[0]=33;replaced=topology.fingerprint()
print(json.dumps({'values':[original,rotated,scaled,replaced]}))
`);
    expect(new Set(result.values).size).toBe(4);
  });

  it("closes an opened X11 connection when topology initialization fails", () => {
    const result = probe(String.raw`
from types import SimpleNamespace
closed=[]
class Function:
    def __init__(self,name):self.name=name
    def __call__(self,*args):
        if self.name=='XOpenDisplay':return 123
        if self.name=='XDefaultRootWindow':return 1
        if self.name=='XCloseDisplay':closed.append(args[0])
        return 0
class Library:
    def __init__(self):self.functions={}
    def __getattr__(self,name):return self.functions.setdefault(name,Function(name))
def library(name):
    if name=='libX11.so.6':return Library()
    raise OSError('dependency missing')
ctypes.CDLL=library
try:X11Desktop()
except NativeFailure as error:code=error.code
print(json.dumps({'code':code,'closed':closed}))
`);
    expect(result).toEqual({
      code: "linux_randr_topology_unavailable",
      closed: [123],
    });
  });
});
