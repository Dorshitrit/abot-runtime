import { execFileSync } from "node:child_process";
import { expect, test } from "vitest";
import { LINUX_OBSERVATION_SCRIPT } from "../../computer-access/companion/observation-linux.js";

// Execute the production collector functions with a virtual GLib clock, without desktop access.
test.skipIf(process.platform !== "linux")(
  "continuous native events mute reads, recover after quiet and keep edit events usable",
  () => {
    const result = execFileSync(
      "python3",
      [
        "-c",
        String.raw`
import ast, sys, json, types, ctypes
source = ast.parse(sys.stdin.read())
ns = {}
exec(compile(ast.Module(body=[node for node in source.body if isinstance(node,ast.FunctionDef)],type_ignores=[]),'<collector>','exec'),ns)
class Clock:
    now=0
    seq=0
    timers={}
    def timeout_add(self,ms,callback):
        self.seq+=1
        self.timers[self.seq]=(self.now+ms/1000,callback)
        return self.seq
    def source_remove(self,id): self.timers.pop(id,None)
    def advance(self,seconds):
        target=self.now+seconds
        while self.timers and min(t[0] for t in self.timers.values())<=target:
            id=min(self.timers,key=lambda id:self.timers[id][0])
            self.now,callback=self.timers.pop(id)
            callback()
        self.now=target
clock=Clock()
reads=[]
events=[]
class Lock:
    def GetActive(self,**kwargs):
        reads.append(clock.now)
        return True # Stop before any desktop read; cadence has already admitted it.
ns.update(GLib=clock,time=types.SimpleNamespace(monotonic=lambda:clock.now),emit=events.append,
          pending=0,maximum=0,editing=False,editing_key=None,editing_document=None,
          last_capture=-5,burst_started=0,burst_captures=0,noise_paused=False,lock_source=Lock())
for _ in range(600):
    ns['changed']()
    clock.advance(.1)
muted_reads=len(reads)
assert ns['noise_paused']
assert muted_reads==4,reads
assert any(e.get('reason')=='continuous_activity' for e in events)
# Muted non-edit notifications do not enumerate the accessibility tree.
def unexpected_read(): raise AssertionError('muted event read the desktop')
ns['active']=unexpected_read
ns['changed'](types.SimpleNamespace(type='object:visible-data-changed'))
clock.advance(30)
assert not ns['noise_paused']
assert len(reads)==muted_reads+1
assert not clock.timers # No idle polling.
# Explicit editable events resume collection while the noisy source is still active.
class Item:
    name='editor'
    def getState(self): return types.SimpleNamespace(contains=lambda state:True)
item=Item()
ns.update(active=lambda:(item,item),window_key=lambda a,w:'editor',pyatspi=types.SimpleNamespace(STATE_EDITABLE=1))
ns['noise_paused']=True
ns['changed'](types.SimpleNamespace(type='object:text-changed:insert',source=item))
assert not ns['noise_paused']
clock.advance(5.01)
assert len(reads)==muted_reads+2
# Window activation also releases the muted source.
ns['noise_paused']=True
ns['changed'](types.SimpleNamespace(type='window:activate',source=item))
assert not ns['noise_paused']
# Exercise the real X11 fallback, including unrelated root-property events.
ns.update(ctypes=ctypes,display=1,active_window_atom=42)
for name in ['XPropertyEvent','xchanged']:
    node=next(node for node in ast.walk(source) if isinstance(node,(ast.ClassDef,ast.FunctionDef)) and node.name==name)
    exec(compile(ast.Module(body=[node],type_ignores=[]),'<x11>','exec'),ns)
xevents=[]
class X11:
    def XPending(self,display): return len(xevents)
    def XNextEvent(self,display,pointer):
        event=ctypes.cast(pointer,ctypes.POINTER(ns['XPropertyEvent'])).contents
        event.type,event.atom=xevents.pop(0)
ns['x11']=X11()
ns['noise_paused']=True
xevents.append((28,99))
ns['xchanged'](0,0)
assert ns['noise_paused']
xevents.append((28,42))
ns['xchanged'](0,0)
assert not ns['noise_paused']
print(json.dumps({'readsDuringMinute':muted_reads,'afterResume':len(reads)}))
`,
      ],
      { input: LINUX_OBSERVATION_SCRIPT, encoding: "utf8" },
    );
    expect(JSON.parse(result)).toEqual({
      readsDuringMinute: 4,
      afterResume: 6,
    });
  },
);
