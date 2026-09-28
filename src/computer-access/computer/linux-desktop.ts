export const LINUX_DESKTOP_SOURCE = String.raw`
import sys, os, json, time, uuid, threading, queue, ctypes, struct, zlib, base64, datetime, math
MAX_PNG = 10 * 1024 * 1024
output_lock = threading.Lock()

class NativeFailure(Exception):

    def __init__(self, code):
        self.code = code
        super().__init__(code)

def emit(value):
    with output_lock:
        print(json.dumps(value, ensure_ascii=False, separators=(',', ':')), flush=True)

def cap(available, reason=None, supported=True):
    result = {'supported': supported, 'available': available}
    if not available and reason:
        result['reason'] = reason
    return result

def bounded_text(value, limit=256):
    return str(value).encode('utf-8')[:limit].decode('utf-8', 'ignore')

def desktop_result(platform, binding, bounds, available, capture, input_, windows, targeting):
    return {'desktop': {'platform': platform, 'binding': binding, 'name': 'User desktop', 'available': available, 'bounds': bounds, 'capabilities': {'capture': capture, 'input': input_, 'windows': windows, 'accessibility': cap(False, 'linux_accessibility_not_available')}, 'targetingGuarantee': targeting}, 'windows': []}

def failed_desktop(code):
    return desktop_result('linux', 'unavailable:linux', {'x': 0, 'y': 0, 'width': 1, 'height': 1}, False, cap(False, code), cap(False, code), cap(False, code), 'observed_surface')

def targeting_guarantee_for_focus(focused):
    if not focused:
        return 'observed_surface'
    return 'verified_window'

def require_observation_source(request, state):
    if request.get('region') is None and request.get('operation') != 'act':
        return
    if request.get('desktopBinding') != state['desktop']['binding']:
        raise NativeFailure('computer_desktop_stale')
    if request.get('expectedGeometry') != state['desktop']['bounds']:
        raise NativeFailure('computer_geometry_changed')

def encode_png(width, height, scanlines):

    def chunk(kind, data):
        return struct.pack('!I', len(data)) + kind + data + struct.pack('!I', zlib.crc32(kind + data) & 4294967295)
    image = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('!2I5B', width, height, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(scanlines, 3)) + chunk(b'IEND', b'')
    if len(image) > MAX_PNG:
        raise NativeFailure('computer_capture_size_limit')
    return image

def point_inside(point, bounds):
    if not all((isinstance(point.get(axis), (int, float)) and math.isfinite(point[axis]) for axis in ['x', 'y'])):
        return False
    return bounds['x'] <= point['x'] < bounds['x'] + bounds['width'] and bounds['y'] <= point['y'] < bounds['y'] + bounds['height']

def capture_region(region, bounds):
    if region is None:
        return bounds.copy()
    if not all((isinstance(region.get(key), (int, float)) and math.isfinite(region[key]) for key in ['x', 'y', 'width', 'height'])):
        raise NativeFailure('computer_region_invalid')
    if region['width'] < 1 or region['height'] < 1:
        raise NativeFailure('computer_region_invalid')
    if not point_inside({'x': region['x'], 'y': region['y']}, bounds):
        raise NativeFailure('computer_region_outside_desktop')
    if region['x'] + region['width'] > bounds['x'] + bounds['width'] or region['y'] + region['height'] > bounds['y'] + bounds['height']:
        raise NativeFailure('computer_region_outside_desktop')
    return {key: round(region[key]) for key in ['x', 'y', 'width', 'height']}

def session_locked():
    try:
        from gi.repository import Gio, GLib
        bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        for service, path in [('org.freedesktop.ScreenSaver', '/org/freedesktop/ScreenSaver'), ('org.gnome.ScreenSaver', '/org/gnome/ScreenSaver')]:
            try:
                result = bus.call_sync(service, path, service, 'GetActive', None, None, Gio.DBusCallFlags.NONE, 1000, None)
                return bool(result.unpack()[0])
            except Exception:
                pass
        return None
    except Exception:
        return None

def read_accessibility(expected_window):
    try:
        import pyatspi
    except ImportError:
        return ([], False, False)
    nodes = []
    pending = []
    started = time.monotonic()
    total = 0
    try:
        expected_pid = int(expected_window['binding'].split(':')[-1])
        if expected_pid <= 0:
            return ([], False, False)
        for app in pyatspi.Registry.getDesktop(0):
            if int(app.get_process_id()) != expected_pid:
                continue
            for window in app:
                if not window.getState().contains(pyatspi.STATE_ACTIVE):
                    continue
                if bounded_text(window.name or '', 128) != expected_window['title']:
                    continue
                pending.append(window)
        if len(pending) != 1:
            return ([], False, False)
        visited = 0
        while pending and visited < 400 and (len(nodes) < 64) and (total < 24000) and (time.monotonic() - started < 0.4):
            item = pending.pop(0)
            visited += 1
            if item.getRole() == pyatspi.ROLE_PASSWORD_TEXT or not item.getState().contains(pyatspi.STATE_SHOWING):
                continue
            node = {'role': bounded_text(item.getRoleName(), 64), 'name': bounded_text(item.name or '', 128), 'focused': item.getState().contains(pyatspi.STATE_FOCUSED)}
            if item.childCount == 0:
                try:
                    text = item.queryText()
                    node['value'] = bounded_text(text.getText(0, min(text.characterCount, 256)))
                except Exception:
                    pass
            total += len(node.get('name', '')) + len(node.get('value', ''))
            nodes.append(node)
            for child in item:
                if len(pending) < 400 and child is not None:
                    pending.append(child)
        return (nodes, bool(pending), True)
    except Exception:
        return (nodes, True, True)

def add_observation(backend, state, region=None):
    bounds = state['desktop']['bounds']
    region = capture_region(region, bounds)
    require_capture_source(state, backend.inspect())
    data, width, height = backend.capture(region)
    nodes, truncated, available = ([], False, False)
    reason = 'selected_surface_accessibility_unbound'
    focused = next((window for window in state['windows'] if window['binding'] == state.get('focusedWindow')), None)
    if focused:
        nodes, truncated, available = read_accessibility(focused)
        reason = 'linux_accessibility_source_unavailable'
    after = backend.inspect()
    require_capture_source_available(state, after)
    if state['desktop']['binding'] != after['desktop']['binding'] or bounds != after['desktop']['bounds']:
        raise NativeFailure('computer_geometry_changed_during_capture')
    if state.get('focusedWindow') != after.get('focusedWindow'):
        raise NativeFailure('computer_focus_changed_during_capture')
    state['desktop']['capabilities']['accessibility'] = cap(available, reason)
    state['observation'] = {'capturedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'region': region, 'imageWidth': width, 'imageHeight': height, 'accessibility': nodes, 'accessibilityTruncated': truncated}
    state['imageBase64'] = base64.b64encode(data).decode('ascii')
    return state

def require_capture_source(expected, current):
    require_capture_source_available(expected, current)
    if expected['desktop']['binding'] != current['desktop']['binding']:
        raise NativeFailure('computer_desktop_stale')
    if expected['desktop']['bounds'] != current['desktop']['bounds']:
        raise NativeFailure('computer_geometry_changed')

def require_capture_source_available(expected, current):
    if current['desktop']['available']:
        return
    expected['desktop'] = current['desktop']
    raise NativeFailure(current['desktop'].get('reason') or 'computer_capture_source_unavailable')
`;
