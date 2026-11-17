# Execution Agent file operations

This plugin provides EA's bounded plain-text reads, new-file creation and range
editing. It is enabled by default and prepares handlers only for a request whose
frozen root contract is `execution_agent`. SUPER retains its existing tools and
authoring behavior. This plugin's own global/model restrictions and request
permissions apply independently of whether the legacy `filesystem` plugin is
installed or permitted.

## Operations

- `read_text`: path, optional line bounds, an exact locator, or an explicit byte window.
  Without a selector, reads lines 1–120 or EOF within the 24,000-byte output budget.
  Explicit line bounds are one-based and keep their requested range. The body has
  no line prefixes. Coverage, total lines and truncation are explicit. A fully returned
  window carries a request-local `range_ref`; a truncated window does not.
  `max_bytes` alone caps the default preview (1–24,000 bytes) without selecting a
  byte range. It cannot combine with explicit line or locator controls.
  For a sub-line window, set zero-based `start_byte` and optionally `max_bytes`
  (1–24,000; default 24,000). This mode cannot combine with line/locator controls.
  The start must be a UTF-8 character boundary; the end backs off to one. A budget
  too small for the next character fails. Returned `start_byte` and exclusive
  `end_byte` identify exactly the observed window; `next_byte` is present only
  when more file content follows. This complete selected window gets a `range_ref`
  even when more file content follows. Offset EOF returns an empty range; past EOF fails.
- `create_text`: create a new UTF-8 file, including missing parent directories.
  Existing files are rejected. EA selects the path and accepted content objective;
  its dedicated author returns the exact new text once.
- `edit_text`: select a path and a required `range_ref` returned by `read_text`.
  The adapter supplies exactly that observed range; the author returns its complete
  replacement as plain text. Content outside the selected range stays unchanged.
  There is no JSON patch mode or implicit last-read selection.

Unrelated reads cannot change the selected range binding. Missing, stale, wrong-path
or unavailable references fail before content authoring or mutation. An empty file
has an empty observed range that can be filled. Empty replacement text deletes the
selected range; identical replacement text is reported as unchanged.

The plugin does not call a model, choose edit locations, or repair generated
content. The separate EA file author owns the one content-generation invocation.
An ordinary read needs no additional model invocation.

## Source, evidence and lifetime

The adapter reads the target internally to capture its revision before authoring,
and binds the prepared bytes to it. This safety snapshot is not projected into
model context. Explicitly selected range text is passive data, not an instruction.
Range references belong to the current request, exact path, revision and window.
They are not conversation memory or permanent file identifiers.
Byte selections use the same retained range state and authoring contract as line
selections. Byte offsets are converted to internal string offsets before binding.
They add no compaction index, implicit full-file context or cross-request memory.
The input-schema change requires republishing saved automations that depend on
the previous `read_text` contract, through the existing dependency check.

Successful mutations return bounded committed-file snapshots through ordinary
canonical tool results. The existing EA evidence and verified-compaction contracts
remain authoritative. Events contain only bounded presentation metadata; they are
not another source of execution state or model context.

Prepared bindings and range references use the existing plugin request-state
mechanism during an approval wait. Resume executes the captured payload without
reauthoring. A changed target or unavailable/stale reference fails before writing.
Legacy exact-edit bindings can be decoded but cannot execute; selecting a fresh
range is required. Their presence does not invalidate separate range/create approvals.
State is bounded and disposed with the request; old range references may be evicted.
After a mutation, read a fresh range before another edit of that file.

## Bounds and safety

- Valid UTF-8 text, preserving BOM, CRLF and final-newline bytes.
- Files up to 1 MiB; generated content up to 256 KiB per invocation.
- One explicitly selected range per edit and 32 retained observed windows.
- Existing root/path, symlink and atomic-write protections apply.
- Cancellation, permissions, approvals and result events use the runtime's
  existing execution lifecycle.

Local adapter and runtime tests cover source binding, source drift, approval
restore, exact bytes, bounded evidence and SUPER isolation. These tests do not
establish live-model task quality or browser behavior.
