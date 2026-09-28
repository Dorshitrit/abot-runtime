/** Persistent Wayland remote-desktop portal session. No compositor-specific input shortcuts. */
export const LINUX_PORTAL_SOURCE = String.raw`
class PortalDesktop:
    BUS = 'org.freedesktop.portal.Desktop'
    PATH = '/org/freedesktop/portal/desktop'
    REMOTE = 'org.freedesktop.portal.RemoteDesktop'
    SCREEN = 'org.freedesktop.portal.ScreenCast'

    def __init__(self):
        import gi
        from gi.repository import Gio, GLib
        self.Gio, self.GLib = (Gio, GLib)
        self.bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        self.session = None
        self.fd = None
        self.pipeline = None
        self.sink = None
        self.stream = None
        self.geometry = {'x': 0, 'y': 0, 'width': 1, 'height': 1}
        self.binding = 'wayland:' + str(uuid.uuid4())
        self.devices = 0
        self.closed = False
        self.Gst = None
        self.remote_available = False
        self.capture_available = False
        self.capture_dimensions = None
        self.capture_layout = None
        self.invalidated_reason = None
        self.subscriptions = []
        try:
            devices = self.call('org.freedesktop.DBus.Properties', 'Get', GLib.Variant('(ss)', (self.REMOTE, 'AvailableDeviceTypes'))).unpack()[0]
            self.remote_available = bool(devices & 3)
        except Exception:
            pass
        try:
            gi.require_version('Gst', '1.0')
            gi.require_version('GstVideo', '1.0')
            from gi.repository import Gst, GstVideo
            self.GstVideo = GstVideo
            Gst.init(None)
            if all((Gst.ElementFactory.find(name) for name in ['pipewiresrc', 'videoconvert', 'appsink'])):
                self.Gst = Gst
            sources = self.call('org.freedesktop.DBus.Properties', 'Get', GLib.Variant('(ss)', (self.SCREEN, 'AvailableSourceTypes'))).unpack()[0]
            self.capture_available = bool(self.Gst and sources & 1)
        except Exception:
            pass

    def call(self, interface, method, parameters, path=None):
        return self.bus.call_sync(self.BUS, path or self.PATH, interface, method, parameters, None, self.Gio.DBusCallFlags.NONE, 5000, None)

    def request(self, interface, method, signature, args, options, cancel):
        token = 'abot_' + uuid.uuid4().hex
        options = dict(options)
        options['handle_token'] = self.GLib.Variant('s', token)
        sender = self.bus.get_unique_name().lstrip(':').replace('.', '_')
        path = '/org/freedesktop/portal/desktop/request/' + sender + '/' + token
        ready = threading.Event()
        result = {}

        def received(connection, sender, path, interface, signal, parameters, data):
            response, values = parameters.unpack()
            result.update({'response': response, 'values': values})
            ready.set()
        subscription = self.bus.signal_subscribe(self.BUS, 'org.freedesktop.portal.Request', 'Response', path, None, self.Gio.DBusSignalFlags.NONE, received, None)
        try:
            self.call(interface, method, self.GLib.Variant(signature, tuple(args) + (options,)))
            deadline = time.monotonic() + 30
            while not ready.wait(0.05):
                if cancel.is_set() or time.monotonic() > deadline:
                    try:
                        self.call('org.freedesktop.portal.Request', 'Close', None, path)
                    except Exception:
                        pass
                    raise NativeFailure('linux_portal_request_cancelled')
            if result['response'] != 0:
                raise NativeFailure('linux_portal_permission_denied')
            return result['values']
        finally:
            self.bus.signal_unsubscribe(subscription)

    def ensure_session(self, cancel):
        if self.closed:
            raise NativeFailure('linux_portal_session_closed')
        if self.session:
            return
        if not self.capture_available:
            raise NativeFailure('linux_pipewire_capture_dependencies_unavailable')
        session_interface = self.REMOTE if self.remote_available else self.SCREEN
        session_token = 'abot_' + uuid.uuid4().hex
        created = self.request(session_interface, 'CreateSession', '(a{sv})', [], {'session_handle_token': self.GLib.Variant('s', session_token)}, cancel)
        self.session = created['session_handle']

        def session_closed(*args):
            self.closed = True
        self.subscriptions.append(self.bus.signal_subscribe(self.BUS, 'org.freedesktop.portal.Session', 'Closed', self.session, None, self.Gio.DBusSignalFlags.NONE, session_closed, None))
        try:
            if self.remote_available:
                self.request(self.REMOTE, 'SelectDevices', '(oa{sv})', [self.session], {'types': self.GLib.Variant('u', 3)}, cancel)
            self.request(self.SCREEN, 'SelectSources', '(oa{sv})', [self.session], {'types': self.GLib.Variant('u', 1), 'multiple': self.GLib.Variant('b', False)}, cancel)
            started = self.request(session_interface, 'Start', '(osa{sv})', [self.session, ''], {}, cancel)
            self.devices = started.get('devices', 0)
            streams = started.get('streams', [])
            if len(streams) != 1:
                raise NativeFailure('linux_portal_single_monitor_required')
            self.stream, properties = streams[0]
            size = properties.get('size')
            if not size or size[0] <= 0 or size[1] <= 0:
                raise NativeFailure('linux_portal_geometry_unavailable')
            self.geometry = {'x': 0, 'y': 0, 'width': size[0], 'height': size[1]}
            returned, fds = self.bus.call_with_unix_fd_list_sync(self.BUS, self.PATH, self.SCREEN, 'OpenPipeWireRemote', self.GLib.Variant('(oa{sv})', (self.session, {})), None, self.Gio.DBusCallFlags.NONE, 5000, None, None)
            self.fd = fds.get(returned.unpack()[0])
            self.pipeline = self.Gst.Pipeline.new('abot-capture')
            source = self.Gst.ElementFactory.make('pipewiresrc', 'source')
            source.set_property('fd', self.fd)
            self.binding = bind_portal_capture_source(self, source, properties)
            convert = self.Gst.ElementFactory.make('videoconvert', 'convert')
            self.sink = self.Gst.ElementFactory.make('appsink', 'sink')
            self.sink.set_property('caps', self.Gst.Caps.from_string('video/x-raw,format=RGB'))
            self.sink.set_property('max-buffers', 1)
            self.sink.set_property('drop', True)
            self.sink.set_property('sync', False)
            for element in [source, convert, self.sink]:
                self.pipeline.add(element)
            if not source.link(convert) or not convert.link(self.sink):
                raise NativeFailure('linux_pipewire_pipeline_failed')
            self.pipeline.set_state(self.Gst.State.PLAYING)
        except Exception:
            self.close()
            raise

    def inspect(self):
        self.validate_stream_dimensions()
        active = not self.closed and (self.remote_available or self.capture_available)
        capture_reason = 'linux_portal_permission_required' if self.capture_available else 'linux_pipewire_capture_dependencies_unavailable'
        input_reason = 'linux_portal_permission_required' if self.remote_available else 'linux_remote_desktop_portal_unavailable'
        has_granted_session = bool(self.session and not self.closed)
        result = desktop_result('linux', self.binding, self.geometry, active, cap(self.capture_available and has_granted_session, capture_reason), cap(self.remote_available and has_granted_session, input_reason), cap(False, 'wayland_window_inventory_unavailable', False), 'observed_surface')
        result['desktop']['coordinateSpace'] = 'logical_points'
        if self.closed:
            result['desktop']['reason'] = self.invalidated_reason or 'linux_portal_session_closed'
        if self.session:
            denied_input = 'linux_portal_input_permission_partial' if self.remote_available else 'linux_remote_desktop_portal_unavailable'
            result['desktop']['capabilities']['input'] = cap(has_granted_session and self.devices & 3 == 3, self.invalidated_reason or denied_input)
        return result

    def source_binding(self):
        self.validate_stream_dimensions()
        if self.closed:
            raise NativeFailure(self.invalidated_reason or 'linux_portal_session_closed')
        return self.binding

    def validate_stream_dimensions(self):
        require_portal_stream_alive(self)
        if not getattr(self, 'sink', None):
            return
        pad = self.sink.get_static_pad('sink')
        caps = pad.get_current_caps() if pad else None
        if not caps:
            return
        require_portal_frame_layout(self, caps)
        structure = caps.get_structure(0)
        dimensions = (structure.get_value('width'), structure.get_value('height'))
        if self.capture_dimensions is not None and self.capture_dimensions != dimensions:
            self.closed = True
            self.invalidated_reason = 'linux_portal_geometry_changed'

    def capture(self, region):
        self.validate_stream_dimensions()
        if self.closed or not self.sink:
            raise NativeFailure('linux_portal_session_unavailable')
        sample = fresh_portal_sample(self)
        require_portal_stream_alive(self)
        require_portal_frame_layout(self, sample.get_caps())
        if self.closed:
            raise NativeFailure(self.invalidated_reason or 'linux_portal_session_closed')
        structure = sample.get_caps().get_structure(0)
        width, height = (structure.get_value('width'), structure.get_value('height'))
        dimensions = (width, height)
        if self.capture_dimensions is not None and dimensions != self.capture_dimensions:
            self.closed = True
            self.invalidated_reason = 'linux_portal_geometry_changed'
            raise NativeFailure(self.invalidated_reason)
        self.capture_dimensions = dimensions
        self.capture_layout = portal_frame_layout(sample.get_caps())
        buffer = sample.get_buffer()
        success, mapped = buffer.map(self.Gst.MapFlags.READ)
        if not success:
            raise NativeFailure('linux_pipewire_frame_unavailable')
        try:
            info = self.GstVideo.VideoInfo.new_from_caps(sample.get_caps())
            if info is None:
                raise NativeFailure('linux_pipewire_pixel_format_unsupported')
            sx = width / self.geometry['width']
            sy = height / self.geometry['height']
            x, y = (round(region['x'] * sx), round(region['y'] * sy))
            w, h = (round(region['width'] * sx), round(region['height'] * sy))
            scale = min(1.0, 2048 / max(w, h))
            output_width, output_height = max(1, round(w * scale)), max(1, round(h * scale))
            rows = []
            for output_row in range(output_height):
                row = y + min(h - 1, int(output_row / scale))
                offset = info.offset[0] + row * info.stride[0] + x * 3
                line = bytearray([0])
                for output_column in range(output_width):
                    column = min(w - 1, int(output_column / scale))
                    line.extend(mapped.data[offset + column * 3:offset + column * 3 + 3])
                rows.append(bytes(line))
            return (encode_png(output_width, output_height, b''.join(rows)), output_width, output_height)
        finally:
            buffer.unmap(mapped)

    def notify(self, method, signature, values):
        self.validate_stream_dimensions()
        if self.closed or not self.session:
            raise NativeFailure('linux_portal_session_closed')
        self.call(self.REMOTE, method, self.GLib.Variant(signature, (self.session, {}) + tuple(values)))

    def pointer(self, point):
        self.notify('NotifyPointerMotionAbsolute', '(oa{sv}udd)', [self.stream, float(point['x']), float(point['y'])])

    def button(self, button, down):
        self.notify('NotifyPointerButton', '(oa{sv}iu)', [{1: 272, 2: 274, 3: 273}[button], int(down)])

    def scroll(self, x, y):
        if x % 120 or y % 120:
            raise NativeFailure('linux_wayland_scroll_fraction_unsupported')
        if x:
            self.notify('NotifyPointerAxisDiscrete', '(oa{sv}ui)', [1, int(x / 120)])
        if y:
            self.notify('NotifyPointerAxisDiscrete', '(oa{sv}ui)', [0, int(y / 120)])

    def key_event(self, key, down):
        self.notify('NotifyKeyboardKeysym', '(oa{sv}iu)', [key, int(down)])

    def key(self, name):
        aliases = {'Ctrl': 65507, 'Control': 65507, 'Alt': 65513, 'Shift': 65505, 'Meta': 65515, 'Super': 65515, 'Command': 65515, 'Enter': 65293, 'Escape': 65307, 'Esc': 65307, 'Tab': 65289, 'Backspace': 65288, 'Delete': 65535, 'Space': 32, 'ArrowLeft': 65361, 'ArrowUp': 65362, 'ArrowRight': 65363, 'ArrowDown': 65364, 'Home': 65360, 'End': 65367, 'PageUp': 65365, 'PageDown': 65366}
        if name in aliases:
            return (aliases[name], False)
        if len(name) == 1:
            return (ord(name) if ord(name) <= 255 else 16777216 | ord(name), False)
        if name.startswith('F') and name[1:].isdigit() and (1 <= int(name[1:]) <= 24):
            return (65469 + int(name[1:]), False)
        raise NativeFailure('linux_key_unmapped')

    def text_keys(self, text):
        return [self.key({'\n': 'Enter', '\t': 'Tab'}.get(char, char)) for char in text]

    def focus(self, binding):
        raise NativeFailure('wayland_window_focus_unavailable')

    def close(self):
        self.closed = True
        if self.pipeline:
            self.pipeline.set_state(self.Gst.State.NULL)
            self.pipeline = None
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None
        if self.session:
            try:
                self.call('org.freedesktop.portal.Session', 'Close', None, self.session)
            except Exception:
                pass
        for subscription in self.subscriptions:
            self.bus.signal_unsubscribe(subscription)
        self.subscriptions = []
        self.session = None
`;
