# Read File Skill

- Use `read_file` for one current text file. The result is complete within the declared read budget; larger files return an explicit bounded head/tail view.
- Treat truncation metadata as authoritative. Do not infer facts from omitted content.
- In development work, prefer the active development reader for scoped existing-file edits.
- Do not reload a freshly written full file just to prove what was written unless exact current text is needed.
