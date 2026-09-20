# Dev View Skill

- `path` identifies one file or directory. For a file, choose numeric `start_line` / `end_line` for a bounded window, or `locator` for one exact literal substring in the bounded scan.
- A locator is not a keyword or regular-expression search: it must identify one occurrence. It takes precedence over numeric lines. When no unique observed substring is known, use numeric lines without a locator.
- `context_lines` supplies surrounding lines for a locator. Numeric windows are capped at 240 lines; scan and output truncation are reported separately.
- `ambiguous_text_locator` is a failed selection. Its bounded candidates contain observed match lines and `nextControls` for numeric reads. Choose a candidate only when it fits the requested operation, and omit `locator` when using its numeric controls. No candidate has been selected or read successfully by that failure.
- Candidate-list truncation and scan truncation are independent. Missing candidates or unscanned content are unknown; a locator-not-found result supplies no file content.
