/** Reject cached portal frames; capture evidence must follow this observation boundary. */
export const LINUX_FRAME_SOURCE = String.raw`
def fresh_portal_sample(backend):
    clock = backend.pipeline.get_clock()
    if clock is None:
        raise NativeFailure('linux_pipewire_clock_unavailable')
    cutoff = max(0, clock.get_time() - backend.pipeline.get_base_time())
    for _ in range(4):
        cached = backend.sink.emit('try-pull-sample', 0)
        if cached is None:
            break
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        sample = backend.sink.emit('try-pull-sample', int(0.2 * backend.Gst.SECOND))
        if sample is None:
            continue
        buffer = sample.get_buffer()
        if buffer.pts == backend.Gst.CLOCK_TIME_NONE:
            continue
        segment = sample.get_segment()
        if segment is None:
            continue
        timestamp = segment.to_running_time(backend.Gst.Format.TIME, buffer.pts)
        if timestamp == backend.Gst.CLOCK_TIME_NONE:
            continue
        if timestamp >= cutoff:
            return sample
    raise NativeFailure('linux_pipewire_fresh_frame_unavailable')
`;
