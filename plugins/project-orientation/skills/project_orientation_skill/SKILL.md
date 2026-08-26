# Project Orientation Skill

Use `inspect_project` before changing an unfamiliar existing project when its
structure, entrypoints, or package scripts are not yet known. Prefer this
bounded orientation before broad file reads. It returns a tree and manifest
summary, not full source content; use the result to choose focused follow-up
reads and preserve the existing project root.

Use `path` as the location contract: `.` targets the configured agent work
directory, relative paths target content beneath it, and `workspace/...`
targets configured workspace sources.
