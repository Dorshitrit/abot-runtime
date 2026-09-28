import { execFileSync } from "node:child_process";
import { expect, test } from "vitest";
import { LINUX_OBSERVATION_SCRIPT } from "../../computer-access/companion/observation-linux.js";

/** Execute the real event adapter against an isolated in-memory accessibility bus; no desktop APIs. */
const fixture = String.raw`
import sys, types, os, time
fixture_now=0
time.monotonic=lambda:fixture_now
os.environ['WAYLAND_DISPLAY']='fixture-display'
os.environ.pop('DISPLAY',None)
os.environ['ABOT_OBSERVATION_EXCLUSIONS']='[]'
class State:
    def __init__(self, values): self.values=values
    def contains(self, value): return value in self.values
class Node:
    def __init__(self,name,path,role=1,states=(1,),text='',children=()):
        self.name,self.path,self.role,self.states,self.text=name,path,role,states,text
        self.children=list(children)
        self.parent=None
        self.rect=types.SimpleNamespace(x=0,y=0,width=800,height=600)
        for child in self.children: child.parent=self
    def __iter__(self): return iter(self.children)
    def getState(self): return State(self.states)
    def getRole(self): return self.role
    def get_process_id(self): return 42
    def queryComponent(self): return types.SimpleNamespace(getExtents=lambda mode:self.rect)
    @property
    def childCount(self): return len(self.children)
    def queryText(self):
        if self.role==7: raise Exception('A protected field was read')
        return types.SimpleNamespace(characterCount=len(self.text),getText=lambda start,end:self.text[start:end])
text_node=Node('editor','/text',role=2,states=(1,3,4),text='draft')
password=Node('secret','/password',role=7,text='must not read')
outside=Node('outside viewport','/outside',role=2,text='not visible')
outside.rect=types.SimpleNamespace(x=2000,y=0,width=400,height=300)
document=Node('document','/doc',role=5,children=(text_node,password,outside))
background_tab=Node('background tab','/otherdoc',role=5,children=(Node('other tab body','/otherbody',role=2,text='unseen tab'),))
window=Node('Untitled','/window',states=(1,2),children=(document,background_tab))
app=Node('Fixture Editor','/app',children=(window,))
desktop=[app]
background=Node('background','/background',role=2,states=(1,3),text='background edit')
locked_flag=False
class Lock:
    def GetActive(self,**kwargs): return locked_flag
lock=Lock()
bus=types.SimpleNamespace(get_object=lambda *args:lock,add_signal_receiver=lambda *args,**kwargs:None)
dbus=types.ModuleType('dbus'); dbus.SessionBus=lambda:bus; dbus.Interface=lambda obj,name:obj
sys.modules['dbus']=dbus
sys.modules['dbus.mainloop']=types.ModuleType('dbus.mainloop')
dbus_glib=types.ModuleType('dbus.mainloop.glib'); dbus_glib.DBusGMainLoop=lambda **kwargs:None
sys.modules['dbus.mainloop.glib']=dbus_glib
timers=[]
def timeout(ms,callback):
    timers.append(ms)
    return len(timers)
glib=types.SimpleNamespace(source_remove=lambda timer:None,timeout_add=timeout,io_add_watch=lambda *args:None,IO_IN=1)
gi=types.ModuleType('gi'); repository=types.ModuleType('gi.repository'); repository.GLib=glib
sys.modules['gi']=gi;sys.modules['gi.repository']=repository
atspi=types.ModuleType('pyatspi')
atspi.STATE_SHOWING=1; atspi.STATE_ACTIVE=2; atspi.STATE_EDITABLE=3; atspi.STATE_FOCUSED=4; atspi.DESKTOP_COORDS=0
atspi.ROLE_LABEL=1; atspi.ROLE_TEXT=2; atspi.ROLE_HEADING=3; atspi.ROLE_DOCUMENT_FRAME=4
atspi.ROLE_DOCUMENT_WEB=5; atspi.ROLE_DOCUMENT_TEXT=6; atspi.ROLE_PASSWORD_TEXT=7
atspi.Registry=types.SimpleNamespace(getDesktop=lambda index:desktop,registerEventListener=lambda *args:None,start=lambda:None)
sys.modules['pyatspi']=atspi
`;

test.skipIf(process.platform === "win32")(
  "Linux adapter settles changes, attributes only foreground editable events, and never reads passwords",
  () => {
    const checks = String.raw`
capture()
fixture_now+=5
text_node.states=(1,4)
changed(types.SimpleNamespace(type='object:text-changed:insert',source=text_node))
capture()
fixture_now+=5
text_node.states=(1,3,4)
changed(types.SimpleNamespace(type='object:text-changed:insert',source=background))
capture()
fixture_now+=5
changed(types.SimpleNamespace(type='object:text-changed:insert',source=text_node))
changed(types.SimpleNamespace(type='object:text-changed:insert',source=text_node))
capture()
fixture_now+=5
text_node.states=(1,3)
capture()
fixture_now+=5
locked_flag=True
capture()
emit({'fixtureTimers':timers})
`;
    const output = execFileSync(
      "python3",
      ["-c", fixture + LINUX_OBSERVATION_SCRIPT + checks],
      { encoding: "utf8", timeout: 5000 },
    );
    const records = output
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const observations = records.filter((entry) => entry.type === "snapshot");
    expect(observations).toHaveLength(5);
    expect(observations.map((entry) => entry.kind)).toEqual([
      "view",
      "view",
      "view",
      "edit",
      "view",
    ]);
    expect(
      observations.slice(0, 4).every((entry) => entry.content === "draft"),
    ).toBe(true);
    expect(observations[4].content).toBe("");
    expect(observations[0].source).toMatchObject({
      processId: 42,
      windowId: "/window",
      documentId: "/doc",
    });
    expect(records).toContainEqual({
      type: "status",
      state: "paused",
      reason: "screen_locked",
    });
    const timers = records.at(-1).fixtureTimers as number[];
    expect(timers.filter((value) => value === 5000)).toHaveLength(3);
    expect(timers.filter((value) => value === 1200)).toHaveLength(4);
  },
);
