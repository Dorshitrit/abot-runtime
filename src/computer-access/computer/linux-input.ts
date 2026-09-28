/** Mechanical action execution. Unicode mapping and all geometry are checked before any input. */
export const LINUX_INPUT_SOURCE = String.raw`
def incomplete_dispatch_error(dispatch):
    status = dispatch['status']
    if status == 'partial':
        return {'code': 'computer_input_partial', 'message': 'Native input was only partially dispatched. Inspect the receipt and fresh observation before another action.'}
    if status == 'unknown':
        return {'code': 'computer_input_unknown', 'message': 'Native input dispatch is uncertain. Inspect the receipt and fresh observation before another action.'}
    return None

def action_input_count(action):
    kind = action.get('kind')
    if kind == 'type_text':
        return len(action.get('text', '')) * 2
    if kind == 'press_keys':
        return len(action.get('keys', [])) * 2
    if kind == 'click':
        return 1 + action.get('count', 1) * 2
    if kind == 'drag':
        return 15
    return 1

def validate_action(action, state, backend):
    kind = action.get('kind')
    if kind not in ['click', 'move', 'drag', 'scroll', 'type_text', 'press_keys', 'focus_window']:
        raise NativeFailure('computer_action_unsupported')
    bounds = state['desktop']['bounds']
    points = []
    if kind in ['click', 'move']:
        points = [action['point']]
    if kind == 'drag':
        points = [action['from'], action['to']]
    for point in points:
        if not point_inside(point, bounds):
            raise NativeFailure('computer_point_outside_desktop')
    if kind == 'click' and action.get('count') not in [1, 2]:
        raise NativeFailure('computer_click_count_invalid')
    if kind in ['click', 'drag'] and action.get('button') not in ['left', 'middle', 'right']:
        raise NativeFailure('computer_button_invalid')
    if kind == 'drag' and (not 0 <= action.get('durationMs', -1) <= 5000):
        raise NativeFailure('computer_drag_duration_invalid')
    if kind == 'scroll':
        values = [action.get('deltaX'), action.get('deltaY')]
        if not all((isinstance(value, (int, float)) and math.isfinite(value) and (abs(value) <= 12000) for value in values)):
            raise NativeFailure('computer_scroll_limit')
        if any((value % 120 for value in values)):
            raise NativeFailure('linux_scroll_fraction_unsupported')
    if kind == 'type_text':
        if not isinstance(action.get('text'), str) or len(action['text']) > 10000:
            raise NativeFailure('computer_text_limit')
        return backend.text_keys(action['text'])
    if kind == 'press_keys':
        if not isinstance(action.get('keys'), list) or not 1 <= len(action['keys']) <= 8:
            raise NativeFailure('computer_keys_invalid')
        return [backend.key(key) for key in action['keys']]
    if kind == 'focus_window':
        if not state['desktop']['capabilities']['windows']['available']:
            raise NativeFailure('computer_window_focus_unavailable')
        if not any((window['binding'] == action.get('windowBinding') for window in state['windows'])):
            raise NativeFailure('computer_window_stale')
    return []

def require_verified_text_focus(backend, action, expected_window):
    if action['kind'] != 'type_text':
        return
    if expected_window is None:
        return
    if backend.focused_window_binding() != expected_window:
        raise NativeFailure('computer_focus_changed')

def execute_input(backend, action, keys, cancel, deadline, id, expected_binding, expected_window=None):
    count = action_input_count(action)
    if action['kind'] == 'type_text':
        count = sum(4 if shift else 2 for key, shift in keys)
    accepted = 0
    held_keys = []
    held_buttons = []

    def check():
        if cancel.is_set():
            raise NativeFailure('computer_action_cancelled')
        if time.time() * 1000 > deadline:
            raise NativeFailure('computer_action_deadline')
        require_verified_text_focus(backend, action, expected_window)

    def event(function, *args):
        nonlocal accepted
        check()
        function(*args)
        accepted += 1

    def down_key(key):
        event(backend.key_event, key, True)
        held_keys.append(key)

    def up_key(key):
        nonlocal accepted
        backend.key_event(key, False)
        held_keys.remove(key)
        accepted += 1

    def down_button(button):
        event(backend.button, button, True)
        held_buttons.append(button)

    def up_button(button):
        nonlocal accepted
        backend.button(button, False)
        held_buttons.remove(button)
        accepted += 1
    check()
    if backend.source_binding() != expected_binding:
        raise NativeFailure('computer_desktop_stale')
    emit({'type': 'dispatch', 'id': id, 'dispatch': {'status': 'unknown', 'requestedInputCount': count, 'reason': 'native_dispatch_started'}})
    failure = None
    try:
        kind = action['kind']
        if kind == 'move':
            event(backend.pointer, action['point'])
        if kind == 'click':
            event(backend.pointer, action['point'])
            button = {'left': 1, 'middle': 2, 'right': 3}[action['button']]
            for index in range(action['count']):
                check()
                down_button(button)
                up_button(button)
                if index + 1 < action['count']:
                    cancel.wait(0.05)
        if kind == 'drag':
            event(backend.pointer, action['from'])
            button = {'left': 1, 'middle': 2, 'right': 3}[action['button']]
            down_button(button)
            for step in range(1, 13):
                point = {axis: action['from'][axis] + (action['to'][axis] - action['from'][axis]) * step / 12 for axis in ['x', 'y']}
                event(backend.pointer, point)
                cancel.wait(action['durationMs'] / 12000)
            check()
            up_button(button)
        if kind == 'scroll':
            event(backend.scroll, action['deltaX'], action['deltaY'])
        if kind == 'focus_window':
            event(backend.focus, action['windowBinding'])
        if kind == 'press_keys':
            for key, shift in keys:
                down_key(key)
            for key, shift in reversed(keys):
                up_key(key)
        if kind == 'type_text':
            for key, shift in keys:
                check()
                if shift:
                    down_key(backend.key('Shift')[0])
                down_key(key)
                up_key(key)
                if shift:
                    up_key(backend.key('Shift')[0])
    except Exception as error:
        failure = error
    finally:
        for key in reversed(held_keys):
            try:
                backend.key_event(key, False)
            except Exception:
                failure = NativeFailure('computer_key_release_uncertain')
        for button in reversed(held_buttons):
            try:
                backend.button(button, False)
            except Exception:
                failure = NativeFailure('computer_button_release_uncertain')
    dispatch = {'status': 'accepted' if failure is None else 'partial' if accepted else 'unknown', 'requestedInputCount': count, 'acceptedInputCount': accepted}
    if failure is not None:
        dispatch['reason'] = failure.code if isinstance(failure, NativeFailure) else 'computer_native_action_failed'
    return dispatch
`;
