/** Native capture-source identity; display union bounds alone cannot identify a layout. */
export const LINUX_TOPOLOGY_SOURCE = String.raw`
import hashlib

def source_fingerprint(records):
    canonical = sorted(json.dumps(record, sort_keys=True, separators=(',', ':')) for record in records)
    return hashlib.sha256(json.dumps(canonical, separators=(',', ':')).encode()).hexdigest()

class RandrResources(ctypes.Structure):
    _fields_ = [('timestamp', ctypes.c_ulong), ('configTimestamp', ctypes.c_ulong), ('ncrtc', ctypes.c_int), ('crtcs', ctypes.POINTER(ctypes.c_ulong)), ('noutput', ctypes.c_int), ('outputs', ctypes.POINTER(ctypes.c_ulong)), ('nmode', ctypes.c_int), ('modes', ctypes.c_void_p)]

class RandrCrtc(ctypes.Structure):
    _fields_ = [('timestamp', ctypes.c_ulong), ('x', ctypes.c_int), ('y', ctypes.c_int), ('width', ctypes.c_uint), ('height', ctypes.c_uint), ('mode', ctypes.c_ulong), ('rotation', ctypes.c_ushort), ('noutput', ctypes.c_int), ('outputs', ctypes.POINTER(ctypes.c_ulong)), ('rotations', ctypes.c_ushort), ('npossible', ctypes.c_int), ('possible', ctypes.POINTER(ctypes.c_ulong))]

class RandrTransform(ctypes.Structure):
    _fields_ = [('pending', ctypes.c_int32 * 9), ('pendingFilter', ctypes.c_void_p), ('pendingCount', ctypes.c_int), ('pendingParams', ctypes.c_void_p), ('current', ctypes.c_int32 * 9), ('currentFilter', ctypes.c_void_p), ('currentCount', ctypes.c_int), ('currentParams', ctypes.c_void_p)]

class X11Topology:
    def __init__(self, desktop):
        self.desktop = desktop
        try:
            self.r = ctypes.CDLL('libXrandr.so.2')
            signatures = {
                'XRRQueryVersion': ([ctypes.c_void_p, ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int)], ctypes.c_int),
                'XRRGetScreenResourcesCurrent': ([ctypes.c_void_p, ctypes.c_ulong], ctypes.POINTER(RandrResources)),
                'XRRFreeScreenResources': ([ctypes.POINTER(RandrResources)], None),
                'XRRGetCrtcInfo': ([ctypes.c_void_p, ctypes.POINTER(RandrResources), ctypes.c_ulong], ctypes.POINTER(RandrCrtc)),
                'XRRFreeCrtcInfo': ([ctypes.POINTER(RandrCrtc)], None),
                'XRRGetCrtcTransform': ([ctypes.c_void_p, ctypes.c_ulong, ctypes.POINTER(ctypes.POINTER(RandrTransform))], ctypes.c_int),
            }
            for name, (args, result) in signatures.items():
                function = getattr(self.r, name)
                function.argtypes, function.restype = args, result
            major, minor = ctypes.c_int(), ctypes.c_int()
            if not self.r.XRRQueryVersion(desktop.display, ctypes.byref(major), ctypes.byref(minor)):
                raise NativeFailure('linux_randr_topology_unavailable')
            if (major.value, minor.value) < (1, 3):
                raise NativeFailure('linux_randr13_required')
        except (OSError, AttributeError):
            raise NativeFailure('linux_randr_topology_unavailable')

    def resources(self):
        resources = self.r.XRRGetScreenResourcesCurrent(self.desktop.display, self.desktop.root)
        if not resources:
            raise NativeFailure('linux_randr_topology_unavailable')
        return resources

    def crtc_record(self, resources, identifier):
        pointer = self.r.XRRGetCrtcInfo(self.desktop.display, resources, identifier)
        if not pointer:
            raise NativeFailure('linux_randr_topology_unavailable')
        try:
            info = pointer.contents
            if info.mode == 0:
                return None
            if not 1 <= info.noutput <= 256:
                raise NativeFailure('linux_randr_topology_unavailable')
            transform = ctypes.POINTER(RandrTransform)()
            if not self.r.XRRGetCrtcTransform(self.desktop.display, identifier, ctypes.byref(transform)) or not transform:
                raise NativeFailure('linux_randr_transform_unavailable')
            try:
                matrix = list(transform.contents.current)
            finally:
                self.desktop.x.XFree(transform)
            return {'crtc': identifier, 'outputs': sorted(info.outputs[:info.noutput]), 'rect': [info.x, info.y, info.width, info.height], 'mode': info.mode, 'rotation': info.rotation, 'transform': matrix}
        finally:
            self.r.XRRFreeCrtcInfo(pointer)

    def fingerprint(self):
        resources = self.resources()
        try:
            info = resources.contents
            epoch = (info.timestamp, info.configTimestamp)
            if not 1 <= info.ncrtc <= 256:
                raise NativeFailure('linux_randr_topology_unavailable')
            records = []
            for identifier in info.crtcs[:info.ncrtc]:
                record = self.crtc_record(resources, identifier)
                if record is not None:
                    records.append(record)
            if not records:
                raise NativeFailure('linux_randr_topology_unavailable')
            current = self.resources()
            try:
                if epoch != (current.contents.timestamp, current.contents.configTimestamp):
                    raise NativeFailure('computer_topology_changed')
            finally:
                self.r.XRRFreeScreenResources(current)
            return source_fingerprint([{'epoch': epoch}] + records)
        finally:
            self.r.XRRFreeScreenResources(resources)
`;
