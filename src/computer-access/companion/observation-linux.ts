/** Requires the session's AT-SPI, GLib and D-Bus Python bindings; never installs dependencies. */
import { OBSERVATION_CAPTURE_POLICY as policy } from "./observation-capture-policy.js";
export const LINUX_OBSERVATION_SCRIPT = String.raw`
import os, json, time, sys
def emit(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)
try:
    import pyatspi
    import dbus
    from gi.repository import GLib
    from dbus.mainloop.glib import DBusGMainLoop
except ImportError:
    emit({'type':'status','state':'unavailable','reason':'linux_atspi_python_dependencies_missing'})
    sys.exit(0)
if not (os.environ.get('DISPLAY') or os.environ.get('WAYLAND_DISPLAY')):
    emit({'type':'status','state':'unavailable','reason':'graphical_session_unavailable'})
    sys.exit(0)
DBusGMainLoop(set_as_default=True)
bus = dbus.SessionBus()
excluded = {str(x).casefold() for x in json.loads(os.environ.get('ABOT_OBSERVATION_EXCLUSIONS','[]'))}
lock_source = None
for name, path, interface in [('org.freedesktop.ScreenSaver','/org/freedesktop/ScreenSaver','org.freedesktop.ScreenSaver'),('org.gnome.ScreenSaver','/org/gnome/ScreenSaver','org.gnome.ScreenSaver')]:
    try:
        candidate = dbus.Interface(bus.get_object(name,path), interface)
        candidate.GetActive(timeout=1)
        lock_source = candidate
        break
    except Exception:
        pass
if lock_source is None:
    emit({'type':'status','state':'unavailable','reason':'session_lock_state_unavailable'})
    sys.exit(0)
pending = 0
maximum = 0
last_capture = -${policy.minimumIntervalMs / 1000}
burst_started = 0
burst_captures = 0
noise_paused = False
editing = False
editing_key = None
editing_document = None
def active():
    desktop = pyatspi.Registry.getDesktop(0)
    for app in desktop:
        if app is None: continue
        for window in app:
            if window is not None and window.getState().contains(pyatspi.STATE_ACTIVE):
                return app, window
    return None, None
def process_id(app):
    return int(app.get_process_id())
def object_id(item):
    return str(item.path)
def document_scope(window):
    queue, count = [window], 0
    started = time.monotonic()
    while queue and count < 400 and time.monotonic()-started < 0.25:
        item = queue.pop(0)
        count += 1
        if not item.getState().contains(pyatspi.STATE_SHOWING): continue
        if item.getState().contains(pyatspi.STATE_FOCUSED):
            ancestor, found = item, None
            for depth in range(32):
                if ancestor is None: break
                if ancestor == window: return found
                if found is None and ancestor.getRole() in [pyatspi.ROLE_DOCUMENT_FRAME,pyatspi.ROLE_DOCUMENT_WEB,pyatspi.ROLE_DOCUMENT_TEXT]: found = ancestor
                ancestor = ancestor.parent
        for child in item:
            if len(queue) >= 400: break
            if child is not None: queue.append(child)
    return None
def documents(window):
    document = document_scope(window)
    return object_id(document) if document is not None else ''
def visible_leaf(item, window):
    try:
        rect = item.queryComponent().getExtents(pyatspi.DESKTOP_COORDS)
        frame = window.queryComponent().getExtents(pyatspi.DESKTOP_COORDS)
        return rect.width > 0 and rect.height > 0 and frame.width > 0 and frame.height > 0 and rect.x < frame.x + frame.width and rect.x + rect.width > frame.x and rect.y < frame.y + frame.height and rect.y + rect.height > frame.y
    except (NotImplementedError, AttributeError):
        return False
def window_key(app, window):
    return str(process_id(app)) + ':' + object_id(window) + ':' + str(window.name)
def identity(app, window):
    return window_key(app,window) + ':' + documents(window)
def capture():
    global pending, maximum, editing, last_capture, burst_started, burst_captures, noise_paused
    if pending: GLib.source_remove(pending)
    if maximum: GLib.source_remove(maximum)
    pending = maximum = 0
    now = time.monotonic()
    if noise_paused:
        noise_paused, burst_captures = False, 0
    if now-last_capture < ${policy.minimumIntervalMs / 1000}:
        pending = GLib.timeout_add(max(1,int((${policy.minimumIntervalMs / 1000}-(now-last_capture))*1000)),capture)
        return False
    if now-burst_started > ${policy.burstWindowMs / 1000}:
        burst_started, burst_captures = now, 0
    if not editing: burst_captures += 1
    if burst_captures > ${policy.burstLimit}:
        noise_paused = True
        emit({'type':'status','state':'paused','reason':'continuous_activity'})
        pending = GLib.timeout_add(${policy.resumeQuietMs},capture)
        return False
    last_capture = now
    kind = 'edit' if editing else 'view'
    editing = False
    try:
        if bool(lock_source.GetActive(timeout=1)):
            emit({'type':'status','state':'paused','reason':'screen_locked'})
            return False
        app, window = active()
        if window is None: return False
        app_name = str(app.name)
        if app_name.casefold() in excluded:
            emit({'type':'status','state':'paused','reason':'application_excluded'})
            return False
        key = identity(app, window)
        document_ids = documents(window)
        edit_matches = editing_key == window_key(app,window)
        if editing_document and editing_document not in document_ids.split('|'): edit_matches = False
        kind = 'edit' if kind == 'edit' and edit_matches else 'view'
        content_root = document_scope(window)
        queue, parts, seen = [content_root if content_root is not None else window], [], set()
        started = time.monotonic()
        count = 0
        while queue and count < 600 and time.monotonic()-started < 0.4 and sum(map(len,parts)) < 24000:
            item = queue.pop(0)
            count += 1
            state = item.getState()
            if item.getRole() == pyatspi.ROLE_PASSWORD_TEXT: continue
            if not state.contains(pyatspi.STATE_SHOWING): continue
            if content_root is None and item.getRole() in [pyatspi.ROLE_DOCUMENT_FRAME,pyatspi.ROLE_DOCUMENT_WEB,pyatspi.ROLE_DOCUMENT_TEXT]: continue
            text = ''
            # Read leaf text/editable values, not a parent document that could include protected descendants.
            if item.childCount == 0 and visible_leaf(item,window):
                try:
                    text_api = item.queryText()
                    text = text_api.getText(0,min(text_api.characterCount,24000))
                except (NotImplementedError, AttributeError):
                    if item.getRole() in [pyatspi.ROLE_LABEL,pyatspi.ROLE_TEXT,pyatspi.ROLE_HEADING]: text = item.name or ''
            if text and text not in seen:
                seen.add(text)
                parts.append(text)
            for child in item:
                if len(queue) >= 600: break
                if child is not None: queue.append(child)
        after_app, after_window = active()
        if after_window is None or identity(after_app,after_window) != key or bool(lock_source.GetActive(timeout=1)): return False
        emit({'type':'snapshot','source':{'app':app_name,'processId':process_id(app),'windowId':object_id(window),'documentId':documents(window),'title':str(window.name)},'content':'\n'.join(parts),'kind':kind,'extraction':'atspi','coverage':'partial' if parts else 'metadata_only','coverageReason':'visible_accessibility_subset','beforeKey':key,'afterKey':key})
        emit({'type':'status','state':'partial','reason':'atspi_application_coverage'})
    except Exception:
        emit({'type':'status','state':'partial','reason':'accessibility_read_unavailable'})
    return False
def schedule_capture():
    global pending, maximum
    if pending: GLib.source_remove(pending)
    pending = GLib.timeout_add(${policy.resumeQuietMs} if noise_paused else 1200, capture)
    if not noise_paused and not maximum: maximum = GLib.timeout_add(5000, capture)
def changed(event=None, *args, switched=False):
    global pending, maximum, editing, editing_key, editing_document, noise_paused, burst_captures, burst_started
    if switched:
        noise_paused, burst_captures, burst_started = False, 0, time.monotonic()
    if event is not None and hasattr(event,'type'):
        try:
            event_type = str(event.type)
            editable_event = event_type.startswith('object:text-changed') and event.source.getState().contains(pyatspi.STATE_EDITABLE)
            if noise_paused and not editable_event and not event_type.startswith('window:activate'):
                schedule_capture()
                return
            app, current = active()
            if current is None: return
            source = event.source
            ancestor = source
            document = None
            for depth in range(32):
                if ancestor is None or ancestor == current: break
                if ancestor.getRole() in [pyatspi.ROLE_DOCUMENT_FRAME,pyatspi.ROLE_DOCUMENT_WEB,pyatspi.ROLE_DOCUMENT_TEXT]: document = object_id(ancestor)
                ancestor = ancestor.parent
            if ancestor != current: return
            if editable_event:
                editing = True
                editing_key = window_key(app,current)
                editing_document = document
            if editing or event_type.startswith('window:activate'):
                noise_paused, burst_captures, burst_started = False, 0, time.monotonic()
        except Exception: return
    schedule_capture()
pyatspi.Registry.registerEventListener(changed,'window:activate','object:state-changed:focused','object:property-change:accessible-name','object:text-changed','object:children-changed','object:visible-data-changed')
bus.add_signal_receiver(changed, signal_name='ActiveChanged')
if os.environ.get('DISPLAY') and not os.environ.get('WAYLAND_DISPLAY'):
    # X11 root-property notifications supplement accessibility focus events, without polling.
    try:
        import ctypes
        x11 = ctypes.CDLL('libX11.so.6')
        x11.XOpenDisplay.restype = ctypes.c_void_p
        x11.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
        x11.XDefaultRootWindow.restype = ctypes.c_ulong
        x11.XConnectionNumber.argtypes = [ctypes.c_void_p]
        x11.XSelectInput.argtypes = [ctypes.c_void_p,ctypes.c_ulong,ctypes.c_long]
        x11.XPending.argtypes = [ctypes.c_void_p]
        x11.XNextEvent.argtypes = [ctypes.c_void_p,ctypes.c_void_p]
        x11.XInternAtom.argtypes = [ctypes.c_void_p,ctypes.c_char_p,ctypes.c_int]
        x11.XInternAtom.restype = ctypes.c_ulong
        class XPropertyEvent(ctypes.Structure):
            _fields_ = [('type',ctypes.c_int),('serial',ctypes.c_ulong),('send_event',ctypes.c_int),('display',ctypes.c_void_p),('window',ctypes.c_ulong),('atom',ctypes.c_ulong),('time',ctypes.c_ulong),('state',ctypes.c_int)]
        display = x11.XOpenDisplay(None)
        if display:
            active_window_atom = x11.XInternAtom(display,b'_NET_ACTIVE_WINDOW',False)
            x11.XSelectInput(display,x11.XDefaultRootWindow(display),1 << 22)
            def xchanged(fd, condition):
                event = (ctypes.c_long * 24)()
                switched = False
                for count in range(64):
                    if not x11.XPending(display): break
                    x11.XNextEvent(display,ctypes.byref(event))
                    property_event = ctypes.cast(ctypes.byref(event),ctypes.POINTER(XPropertyEvent)).contents
                    if property_event.type == 28 and property_event.atom == active_window_atom:
                        switched = True
                if switched: changed(switched=True)
                return True
            GLib.io_add_watch(x11.XConnectionNumber(display),GLib.IO_IN,xchanged)
    except Exception:
        emit({'type':'status','state':'partial','reason':'x11_events_unavailable_atspi_only'})
emit({'type':'status','state':'partial','reason':'wayland_atspi_coverage' if os.environ.get('WAYLAND_DISPLAY') else 'x11_atspi_coverage'})
changed()
pyatspi.Registry.start()
`;
