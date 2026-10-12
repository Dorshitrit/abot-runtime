# Code Outline

Extracts a bounded structural outline from one source file on Linux, macOS,
or native Windows. Relative paths use the configured agent work directory;
`workspace/...` uses configured workspace sources. Absolute host paths must
remain inside an authorized root. Request path restrictions still apply.

The existing parser and limits are shared across platforms: at most 512 KiB
of source, 160 symbols, 40 imports and 6,000 output characters. JavaScript and
TypeScript use the syntax parser; other supported formats use the existing
pattern-based outline. The tool does not execute the source.

## Windows requirements

Windows uses the SDK's built-in Windows PowerShell/C# reader. No Companion,
WSL, Docker, administrator elevation or execution-policy bypass is required.
If computer policy blocks the reader, the tool reports
`code_outline_safe_read_unavailable` and tells the model not to retry or
bypass the restriction. Cancellation stops the read. Reparse-point escapes
and files larger than the limit are rejected without returning source.
