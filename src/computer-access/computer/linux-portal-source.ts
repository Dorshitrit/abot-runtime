/** One selected portal stream has its own coordinate space and immutable source identity. */
export const LINUX_PORTAL_SOURCE_IDENTITY = String.raw`
def bind_portal_capture_source(backend, source, properties):
    serial = properties.get('pipewire-serial')
    if serial is not None:
        if not source.find_property('target-object'):
            raise NativeFailure('linux_pipewire_stable_target_unavailable')
        source.set_property('target-object', str(serial))
    else:
        source.set_property('path', str(backend.stream))
    # Legacy pipewiresrc connects with DONT_RECONNECT; never rebuild this pipeline after loss.
    if source.find_property('on-disconnect'):
        backend.Gst.util_set_object_arg(source, 'on-disconnect', 'error')
    selected = {key: properties[key] for key in ['id', 'mapping_id', 'pipewire-serial', 'position', 'size', 'source_type'] if key in properties}
    return 'wayland:' + source_fingerprint([{'session': backend.session, 'node': backend.stream, 'source': selected, 'geometry': backend.geometry}])

def require_portal_stream_alive(backend):
    pipeline = getattr(backend, 'pipeline', None)
    if pipeline is None:
        return
    kinds = backend.Gst.MessageType
    for _ in range(64):
        message = pipeline.get_bus().pop_filtered(kinds.ERROR | kinds.EOS | kinds.TAG)
        if message is None:
            return
        if message.type == kinds.TAG:
            present, orientation = message.parse_tag().get_string('image-orientation')
            if present:
                require_portal_orientation(backend, orientation)
            continue
        backend.closed = True
        backend.invalidated_reason = 'linux_portal_source_changed'
        return
    backend.closed = True
    backend.invalidated_reason = 'linux_portal_source_status_unavailable'

def require_portal_orientation(backend, orientation):
    previous = getattr(backend, 'source_orientation', None)
    backend.source_orientation = orientation
    if previous is None:
        return
    if getattr(backend, 'capture_layout', None) is None:
        return
    if previous == orientation:
        return
    backend.closed = True
    backend.invalidated_reason = 'linux_portal_geometry_changed'

def portal_frame_layout(caps):
    structure = caps.get_structure(0)
    return tuple(str(structure.get_value(key)) if structure.has_field(key) else '' for key in ['width', 'height', 'format', 'pixel-aspect-ratio', 'interlace-mode'])

def require_portal_frame_layout(backend, caps):
    expected = getattr(backend, 'capture_layout', None)
    if expected is None:
        return
    current = portal_frame_layout(caps)
    if current == expected:
        return
    backend.closed = True
    backend.invalidated_reason = 'linux_portal_geometry_changed'
`;
