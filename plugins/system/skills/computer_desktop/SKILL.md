# Desktop observation and input

Use computer_desktops when desktop identity or readiness needs discovery. Read capture, accessibility, input and window readiness separately; a command connection does not prove a usable desktop. Existing windows and signed-in sessions are reused. Discovery invalidates previous observation and window references before inspecting the desktop, even if inspection fails. Obtain a usable observation of the chosen desktop before input.

computer_observe returns a screenshot, bounded accessibility content and fresh references. A full or regional observation attempt invalidates the earlier references before capture; only a usable result supplies fresh references. For a region, select a rectangle inside the current image; then use coordinates in the newly returned image. All action coordinates start at (0,0) in the last image. The plugin maps action coordinates to the OS and presents window/accessibility bounds in image coordinates; do not perform scaling, offset or DPI conversion yourself. Occluded or omitted content is not observed content.

Choose one explicit action using the current desktop_ref and observation_ref. Input requires an observation no more than two minutes old and consumes that reference before dispatch. computer_act attempts to return the next screenshot and fresh references automatically. When usable, continue from that result; an extra observe call is not required after each action. If capture fails or an observation is absent, too old or stale, observe again before input. Use window_ref only from the current observation.

Click/move/drag use image positions; type_text inserts literal text; press_keys accepts an array of key names rather than a shell command. Use the operation's platform guidance for keys and scroll units. focus_window requests the exact observed window; platform restrictions may reject it.

Dispatch status distinguishes not_dispatched, accepted, partial and unknown. Accepted input proves injection, not the requested application effect. Use the returned image and accessibility evidence to judge the result. If post-action capture fails, retain the input receipt and observe again; do not repeat a possibly completed click or keystroke. Focus, geometry or session drift may invalidate an action.

Images and references are temporary request evidence, not reusable session history. Native OS permissions still apply. Report the specific unavailable capability; do not replace a desktop or take over a different session to continue.
