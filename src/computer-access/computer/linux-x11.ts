/** X11 server APIs; screenshots never leave memory. All input is XTEST, never a shell command. */
export const LINUX_X11_SOURCE = String.raw`
class XImage(ctypes.Structure):
    _fields_ = [('width', ctypes.c_int), ('height', ctypes.c_int), ('xoffset', ctypes.c_int), ('format', ctypes.c_int), ('data', ctypes.c_void_p), ('byte_order', ctypes.c_int), ('bitmap_unit', ctypes.c_int), ('bitmap_bit_order', ctypes.c_int), ('bitmap_pad', ctypes.c_int), ('depth', ctypes.c_int), ('bytes_per_line', ctypes.c_int), ('bits_per_pixel', ctypes.c_int), ('red_mask', ctypes.c_ulong), ('green_mask', ctypes.c_ulong), ('blue_mask', ctypes.c_ulong)]

class X11Desktop:

    def __init__(self):
        self.x = ctypes.CDLL('libX11.so.6')
        self.t = None
        signatures = {'XOpenDisplay': ([ctypes.c_char_p], ctypes.c_void_p), 'XDefaultRootWindow': ([ctypes.c_void_p], ctypes.c_ulong), 'XInternAtom': ([ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int], ctypes.c_ulong), 'XGetWindowProperty': ([ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_long, ctypes.c_long, ctypes.c_int, ctypes.c_ulong, ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_void_p)], ctypes.c_int), 'XGetGeometry': ([ctypes.c_void_p, ctypes.c_ulong, ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_uint), ctypes.POINTER(ctypes.c_uint), ctypes.POINTER(ctypes.c_uint), ctypes.POINTER(ctypes.c_uint)], ctypes.c_int), 'XTranslateCoordinates': ([ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_int, ctypes.c_int, ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_ulong)], ctypes.c_int), 'XGetImage': ([ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_int, ctypes.c_uint, ctypes.c_uint, ctypes.c_ulong, ctypes.c_int], ctypes.POINTER(XImage)), 'XDestroyImage': ([ctypes.POINTER(XImage)], ctypes.c_int), 'XFree': ([ctypes.c_void_p], ctypes.c_int), 'XFlush': ([ctypes.c_void_p], ctypes.c_int), 'XCloseDisplay': ([ctypes.c_void_p], ctypes.c_int), 'XKeysymToKeycode': ([ctypes.c_void_p, ctypes.c_ulong], ctypes.c_ubyte), 'XStringToKeysym': ([ctypes.c_char_p], ctypes.c_ulong), 'XGetKeyboardMapping': ([ctypes.c_void_p, ctypes.c_ubyte, ctypes.c_int, ctypes.POINTER(ctypes.c_int)], ctypes.POINTER(ctypes.c_ulong)), 'XSetErrorHandler': ([ctypes.c_void_p], ctypes.c_void_p)}
        for name, (args, result) in signatures.items():
            function = getattr(self.x, name)
            function.argtypes = args
            function.restype = result
        self.error_callback = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p)(lambda display, event: 0)
        self.x.XSetErrorHandler(self.error_callback)
        self.display = self.x.XOpenDisplay(None)
        if not self.display:
            raise NativeFailure('linux_x11_display_unavailable')
        self.root = self.x.XDefaultRootWindow(self.display)
        try:
            self.t = ctypes.CDLL('libXtst.so.6')
            self.t.XTestFakeMotionEvent.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_ulong]
            self.t.XTestFakeButtonEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
            self.t.XTestFakeKeyEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
            self.t.XTestQueryExtension.argtypes = [ctypes.c_void_p] + [ctypes.POINTER(ctypes.c_int)] * 4
            values = [ctypes.c_int() for _ in range(4)]
            if not self.t.XTestQueryExtension(self.display, *[ctypes.byref(value) for value in values]):
                self.t = None
        except OSError:
            self.t = None
        self.binding = 'x11:' + os.environ.get('XDG_SESSION_ID', 'session') + ':' + str(uuid.uuid4())
        try:
            self.topology = X11Topology(self)
        except Exception:
            self.x.XCloseDisplay(self.display)
            self.display = None
            raise

    def source_binding(self):
        return self.binding + ':' + self.topology.fingerprint()

    def focused_window_binding(self):
        active = self.property(self.root, '_NET_ACTIVE_WINDOW') or []
        if not active or not active[0]:
            return None
        pid = (self.property(active[0], '_NET_WM_PID') or [0])[0]
        return str(active[0]) + ':' + str(pid)

    def property(self, window, name):
        atom = self.x.XInternAtom(self.display, name.encode(), True)
        if not atom:
            return None
        actual, format_, count, remaining = (ctypes.c_ulong(), ctypes.c_int(), ctypes.c_ulong(), ctypes.c_ulong())
        data = ctypes.c_void_p()
        status = self.x.XGetWindowProperty(self.display, window, atom, 0, 16384, False, 0, ctypes.byref(actual), ctypes.byref(format_), ctypes.byref(count), ctypes.byref(remaining), ctypes.byref(data))
        if status or not data:
            return None
        try:
            if format_.value == 8:
                return ctypes.string_at(data, count.value).decode('utf-8', 'replace')
            if format_.value == 32:
                return list(ctypes.cast(data, ctypes.POINTER(ctypes.c_ulong))[:count.value])
            return None
        finally:
            self.x.XFree(data)

    def geometry(self, window):
        root, child = (ctypes.c_ulong(), ctypes.c_ulong())
        x, y = (ctypes.c_int(), ctypes.c_int())
        w, h, border, depth = (ctypes.c_uint(), ctypes.c_uint(), ctypes.c_uint(), ctypes.c_uint())
        if not self.x.XGetGeometry(self.display, window, ctypes.byref(root), ctypes.byref(x), ctypes.byref(y), ctypes.byref(w), ctypes.byref(h), ctypes.byref(border), ctypes.byref(depth)):
            return None
        if window != self.root:
            if not self.x.XTranslateCoordinates(self.display, window, self.root, 0, 0, ctypes.byref(x), ctypes.byref(y), ctypes.byref(child)):
                return None
        return {'x': x.value, 'y': y.value, 'width': w.value, 'height': h.value}

    def inspect(self):
        bounds = self.geometry(self.root)
        if not bounds:
            raise NativeFailure('linux_x11_geometry_unavailable')
        active = self.property(self.root, '_NET_ACTIVE_WINDOW') or []
        ids = self.property(self.root, '_NET_CLIENT_LIST_STACKING') or self.property(self.root, '_NET_CLIENT_LIST')
        windows = []
        for xid in (ids or [])[:64]:
            geometry = self.geometry(xid)
            if not geometry:
                continue
            pid = (self.property(xid, '_NET_WM_PID') or [0])[0]
            windows.append({'binding': str(xid) + ':' + str(pid), 'title': bounded_text(self.property(xid, '_NET_WM_NAME') or self.property(xid, 'WM_NAME') or '', 128), 'bounds': geometry, 'focused': bool(active and active[0] == xid)})
        result = desktop_result('linux', self.source_binding(), bounds, True, cap(True), cap(self.t is not None, 'linux_xtest_unavailable'), cap(ids is not None, 'linux_window_inventory_unavailable'), 'observed_surface')
        result['windows'] = windows
        result['desktop']['coordinateSpace'] = 'physical_pixels'
        for window in windows:
            if window['focused']:
                result['focusedWindow'] = window['binding']
        result['desktop']['targetingGuarantee'] = targeting_guarantee_for_focus(result.get('focusedWindow'))
        return result

    def capture(self, region):
        image = self.x.XGetImage(self.display, self.root, int(region['x']), int(region['y']), int(region['width']), int(region['height']), ctypes.c_ulong(-1).value, 2)
        if not image:
            raise NativeFailure('linux_x11_capture_failed')
        try:
            info = image.contents
            if info.bits_per_pixel not in (16, 24, 32):
                raise NativeFailure('linux_x11_pixel_format_unsupported')
            pixel_size = info.bits_per_pixel // 8
            source = ctypes.string_at(info.data, info.bytes_per_line * info.height)
            rows = []
            masks = [info.red_mask, info.green_mask, info.blue_mask]
            shifts = [(mask & -mask).bit_length() - 1 for mask in masks]
            maxima = [mask >> shift for mask, shift in zip(masks, shifts)]
            scale = min(1.0, 2048 / max(info.width, info.height))
            output_width = max(1, round(info.width * scale))
            output_height = max(1, round(info.height * scale))
            for output_row in range(output_height):
                row = min(info.height - 1, int(output_row / scale))
                line = bytearray([0])
                for output_column in range(output_width):
                    column = min(info.width - 1, int(output_column / scale))
                    offset = row * info.bytes_per_line + column * pixel_size
                    value = int.from_bytes(source[offset:offset + pixel_size], 'little' if info.byte_order == 0 else 'big')
                    line.extend((((value & mask) >> shift) * 255 // maximum for mask, shift, maximum in zip(masks, shifts, maxima)))
                rows.append(bytes(line))
            return (encode_png(output_width, output_height, b''.join(rows)), output_width, output_height)
        finally:
            self.x.XDestroyImage(image)

    def key(self, name):
        aliases = {'Ctrl': 'Control_L', 'Control': 'Control_L', 'Alt': 'Alt_L', 'Shift': 'Shift_L', 'Meta': 'Super_L', 'Super': 'Super_L', 'Command': 'Super_L', 'Enter': 'Return', 'Esc': 'Escape', 'Backspace': 'BackSpace', 'Space': 'space', 'ArrowLeft': 'Left', 'ArrowRight': 'Right', 'ArrowUp': 'Up', 'ArrowDown': 'Down', 'PageUp': 'Prior', 'PageDown': 'Next'}
        symbol = self.x.XStringToKeysym(aliases.get(name, name).encode('ascii', 'strict'))
        code = self.x.XKeysymToKeycode(self.display, symbol)
        if not symbol or not code:
            raise NativeFailure('linux_key_unmapped')
        return (int(code), False)

    def text_keys(self, text):
        self.x.XkbGetState.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_void_p]
        self.x.XkbKeycodeToKeysym.argtypes = [ctypes.c_void_p, ctypes.c_ubyte, ctypes.c_int, ctypes.c_int]
        self.x.XkbKeycodeToKeysym.restype = ctypes.c_ulong
        state = (ctypes.c_ubyte * 256)()
        if self.x.XkbGetState(self.display, 0x100, ctypes.byref(state)) != 0:
            raise NativeFailure('linux_keyboard_state_unavailable')
        group, modifiers = state[0], state[6]
        if modifiers & (1 | 2 | 4 | 8 | 64):
            raise NativeFailure('linux_text_active_modifiers_unsupported')
        keys = []
        for character in text:
            symbol = {'\n': 65293, '\t': 65289}.get(character, ord(character) if ord(character) <= 255 else 16777216 | ord(character))
            code = self.x.XKeysymToKeycode(self.display, symbol)
            if not code:
                raise NativeFailure('linux_text_character_unmapped')
            plain = self.x.XkbKeycodeToKeysym(self.display, code, group, 0)
            shifted = self.x.XkbKeycodeToKeysym(self.display, code, group, 1)
            if plain == symbol:
                keys.append((int(code), False))
                continue
            if shifted == symbol:
                keys.append((int(code), True))
                continue
            raise NativeFailure('linux_text_character_unmapped')
        return keys

    def pointer(self, point):
        if not self.t.XTestFakeMotionEvent(self.display, -1, round(point['x']), round(point['y']), 0):
            raise NativeFailure('linux_xtest_pointer_rejected')
        self.x.XFlush(self.display)

    def button(self, button, down):
        if not self.t.XTestFakeButtonEvent(self.display, button, int(down), 0):
            raise NativeFailure('linux_xtest_button_rejected')
        self.x.XFlush(self.display)

    def key_event(self, key, down):
        if not self.t.XTestFakeKeyEvent(self.display, key, int(down), 0):
            raise NativeFailure('linux_xtest_key_rejected')
        self.x.XFlush(self.display)

    def scroll(self, x, y):
        for amount, positive, negative in [(y / 120, 5, 4), (x / 120, 7, 6)]:
            if abs(amount) > 100:
                raise NativeFailure('linux_scroll_limit')
            for _ in range(abs(round(amount))):
                self.button(positive if amount > 0 else negative, True)
                self.button(positive if amount > 0 else negative, False)

    def focus(self, binding):

        class XClientMessageData(ctypes.Union):
            _fields_ = [('b', ctypes.c_char * 20), ('s', ctypes.c_short * 10), ('l', ctypes.c_long * 5)]

        class XClientMessage(ctypes.Structure):
            _fields_ = [('type', ctypes.c_int), ('serial', ctypes.c_ulong), ('send_event', ctypes.c_int), ('display', ctypes.c_void_p), ('window', ctypes.c_ulong), ('message_type', ctypes.c_ulong), ('format', ctypes.c_int), ('data', XClientMessageData)]

        class XEvent(ctypes.Union):
            _fields_ = [('client', XClientMessage), ('pad', ctypes.c_long * 24)]
        event = XEvent()
        event.client.type = 33
        event.client.display = self.display
        event.client.window = int(binding.split(':')[0])
        event.client.message_type = self.x.XInternAtom(self.display, b'_NET_ACTIVE_WINDOW', False)
        event.client.format = 32
        event.client.data.l[0] = 2
        event.client.data.l[1] = 0
        self.x.XSendEvent.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_long, ctypes.POINTER(XEvent)]
        if not self.x.XSendEvent(self.display, self.root, False, 1 << 20 | 1 << 19, ctypes.byref(event)):
            raise NativeFailure('linux_window_focus_failed')
        self.x.XFlush(self.display)

    def close(self):
        if self.display:
            self.x.XCloseDisplay(self.display)
            self.display = None
`;
