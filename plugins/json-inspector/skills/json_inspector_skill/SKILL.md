# JSON Inspector Skill

Use `inspect_json` when a JSON artifact or configuration is central to the
task. Validate its syntax and inspect its bounded shape before relying on or
editing it. The tool diagnoses only; it never repairs or edits the file.

Use `path` as the location contract: `.` and relative paths target the
configured agent work directory, `workspace/...` targets configured workspace
sources.
