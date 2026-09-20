# Exec Skill

- Use `exec` for shell work needed by the user's task. Prefer dedicated capabilities when they express that work directly.
- `exec` uses non-interactive `/bin/bash` on Linux and macOS; it does not select a Windows shell. Use commands available on that target OS.
- Supply an explicit existing `cwd`. `.` and relative paths start from the configured agent-work directory, not an implicit Worker directory. `workspace/...` selects the configured workspace; absolute host directories are accepted.
- To create a project, select an existing parent `cwd` and create its directory in the command. A selected project provides working context, not a filesystem sandbox.
- The whole exec family is sensitive: Ask and Full request approval of each exact action through the normal tool flow; FULL+ executes without an additional ABot prompt. Submit the needed operation instead of declaring it unavailable solely because of the selected mode.
- Commands run as the runtime OS user. The plugin does not parse command contents to infer sensitivity or restrict referenced paths. OS permissions still apply; FULL+ does not grant root or Administrator rights.
- Execution has no interactive terminal and retains time, output and process limits. Use non-interactive forms; a terminal prompt cannot be answered through this tool.
- For multi-line input, use a single-quoted here-document when it preserves the intended shell input.
- If a process remains active, continue that exact process with `exec_wait`; do not launch the command again.
