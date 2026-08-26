# Code Outline Skill

Use `inspect_code_outline` when an unfamiliar source file's structure must be
understood before a focused read or edit. Prefer it over repeatedly reading a
large file with no target. It returns symbols and imports without the full
source; use exact current line context before mutation.

Relative paths resolve beneath the configured agent work directory. Use
`workspace/...` only for configured workspace sources.
