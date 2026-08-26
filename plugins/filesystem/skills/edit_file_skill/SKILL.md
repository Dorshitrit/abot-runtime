# Edit File Skill

- Use `edit_file` for one coherent change to one existing file when the target path and requested result are known.
- At capability selection, provide only the exact target in `selectionControls.path`; the runtime freezes it.
- During the pending execution decision, do not repeat or change the frozen path. Provide only a concise implementation instruction in the remaining controls; the editor receives complete current target content separately.
- Do not inspect the file merely to preserve its unrelated content. Inspect only when a missing current fact is needed to formulate the instruction or coordinate another target.
- Include exact observed names or relationships in the instruction when the edited target must connect to another artifact.
- Use `write_file` for a missing target or an explicitly requested complete replacement.
