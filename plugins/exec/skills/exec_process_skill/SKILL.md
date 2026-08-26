# Exec Process Skill

- Use `exec_wait` only after `exec` reports that the command is still running.
- Copy the latest `process_id` and `cursor` exactly and continue the same process without restarting its command.
- Use `exec_cancel` only when the current task no longer needs the active process or the user asks to stop it.
- Process IDs belong to one loaded plugin instance and session; never reuse one across runtimes or sessions.
- Do not cancel a process whose result is still required, and do not retry a stale cursor unchanged.
