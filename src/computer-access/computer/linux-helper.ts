import { LINUX_DESKTOP_SOURCE } from "./linux-desktop.js";
import { LINUX_X11_SOURCE } from "./linux-x11.js";
import { LINUX_PORTAL_SOURCE } from "./linux-portal.js";
import { LINUX_INPUT_SOURCE } from "./linux-input.js";
import { LINUX_FRAME_SOURCE } from "./linux-frame.js";
import { LINUX_TOPOLOGY_SOURCE } from "./linux-topology.js";
import { LINUX_PORTAL_SOURCE_IDENTITY } from "./linux-portal-source.js";

const LINUX_COMMAND_LOOP = String.raw`
backend = None
backend_error = None
jobs = queue.Queue()
cancellations = {}
stopping = threading.Event()

def get_backend():
    global backend, backend_error
    if backend is not None:
        return backend
    if backend_error:
        raise NativeFailure(backend_error)
    try:
        if os.environ.get('WAYLAND_DISPLAY'):
            backend = PortalDesktop()
        elif os.environ.get('DISPLAY'):
            backend = X11Desktop()
        else:
            raise NativeFailure('linux_graphical_session_unavailable')
        return backend
    except NativeFailure as error:
        backend_error = error.code
        raise
    except (ImportError, OSError):
        backend_error = 'linux_native_dependencies_unavailable'
        raise NativeFailure(backend_error)

def operation(id, request, cancel):
    state = None
    dispatch = None
    try:
        if cancel.is_set():
            raise NativeFailure('computer_action_cancelled')
        native = get_backend()
        if isinstance(native, PortalDesktop) and request['operation'] != 'inspect':
            native.ensure_session(cancel)
        state = native.inspect()
        locked = session_locked()
        if locked is True:
            raise NativeFailure('computer_session_locked')
        if isinstance(native, X11Desktop) and locked is None:
            raise NativeFailure('linux_session_lock_state_unavailable')
        if request['operation'] == 'inspect':
            return state
        if request['operation'] == 'observe':
            require_observation_source(request, state)
            return add_observation(native, state, request.get('region'))
        if request['operation'] != 'act':
            raise NativeFailure('computer_operation_unsupported')
        require_observation_source(request, state)
        if request.get('expectedWindow') and request['expectedWindow'] != state.get('focusedWindow'):
            raise NativeFailure('computer_focus_changed')
        if not state['desktop']['capabilities']['input']['available']:
            raise NativeFailure('computer_input_unavailable')
        keys = validate_action(request['action'], state, native)
        dispatch = execute_input(native, request['action'], keys, cancel, request['deadlineEpochMs'], id, request['desktopBinding'], request.get('expectedWindow'))
        emit({'type': 'dispatch', 'id': id, 'dispatch': dispatch})
        state = native.inspect()
        state['dispatch'] = dispatch
        require_observation_source(request, state)
        dispatch_error = incomplete_dispatch_error(dispatch)
        if dispatch_error:
            state['error'] = dispatch_error
        if request['action']['kind'] == 'focus_window' and state.get('focusedWindow') != request['action']['windowBinding']:
            state['error'] = {'code': 'computer_focus_not_confirmed', 'message': 'The window manager accepted the request but the target focus is not confirmed.'}
        try:
            return add_observation(native, state)
        except Exception:
            state['error'] = {'code': 'computer_post_action_capture_failed', 'message': 'Input dispatch settled but the subsequent capture failed; do not repeat the input without inspection.'}
            return state
    except Exception as error:
        code = error.code if isinstance(error, NativeFailure) else 'computer_native_operation_failed'
        state = state or failed_desktop(code)
        state['error'] = {'code': code, 'message': 'The native desktop operation could not complete.'}
        if request.get('operation') == 'act':
            state['dispatch'] = dispatch or {'status': 'not_dispatched', 'requestedInputCount': action_input_count(request.get('action', {})), 'acceptedInputCount': 0, 'reason': code}
        if code in ['computer_session_locked', 'linux_session_lock_state_unavailable']:
            state['desktop']['available'] = False
            state['desktop']['reason'] = code
            for capability in state['desktop']['capabilities'].values():
                capability.update({'available': False, 'reason': code})
        return state

def worker():
    while not stopping.is_set():
        value = jobs.get()
        if value is None:
            return
        id = value['id']
        cancel = cancellations[id]
        result = operation(id, value['request'], cancel)
        emit({'type': 'result', 'id': id, 'result': result})
        cancellations.pop(id, None)

worker_thread = None

def shutdown():
    if stopping.is_set():
        return
    stopping.set()
    for cancel in list(cancellations.values()):
        cancel.set()
    jobs.put(None)
    if worker_thread is not None:
        worker_thread.join(timeout=2)
    if backend is not None:
        try:
            backend.close()
        except Exception:
            pass
    os._exit(0)

def input_loop():
    for line in sys.stdin:
        try:
            if len(line) > 65536:
                break
            value = json.loads(line)
            if value['type'] == 'close':
                break
            if value['type'] == 'cancel':
                if value.get('id') in cancellations:
                    cancellations[value['id']].set()
                continue
            if value['type'] != 'request' or not isinstance(value.get('id'), str):
                break
            cancellations[value['id']] = threading.Event()
            jobs.put(value)
        except Exception:
            break
    shutdown()
if __name__ == '__main__':
    import signal
    signal.signal(signal.SIGTERM, lambda number, frame: threading.Thread(target=shutdown, daemon=True).start())
    worker_thread = threading.Thread(target=worker, daemon=True)
    worker_thread.start()
    threading.Thread(target=input_loop, daemon=True).start()
    try:
        from gi.repository import GLib
        GLib.MainLoop().run()
    except ImportError:
        stopping.wait()
`;

export const LINUX_COMPUTER_HELPER = [
  LINUX_DESKTOP_SOURCE,
  LINUX_TOPOLOGY_SOURCE,
  LINUX_PORTAL_SOURCE_IDENTITY,
  LINUX_X11_SOURCE,
  LINUX_PORTAL_SOURCE,
  LINUX_INPUT_SOURCE,
  LINUX_FRAME_SOURCE,
  LINUX_COMMAND_LOOP,
].join("\n");
