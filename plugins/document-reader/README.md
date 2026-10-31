# Document Reader

Reads bounded text from PDF, DOCX, XLSX, PPTX, TXT, CSV, MD, JSON and RTF files
on Linux, macOS and native Windows. Sources are request attachments or files
inside the configured agent work directory and workspace. Request-specific
path restrictions and attachment identities retain their existing meaning.

The shared limits remain 10 MiB per input file, 40,000 characters per requested
window, and the existing archive expansion and PDF worker resource limits.
Results describe pagination and omitted text. The reader does not execute
document macros or modify the source.

## Windows requirements

The SDK reads through built-in Windows PowerShell and its C# helper. No
Companion, WSL, Docker, elevation or execution-policy bypass is needed.
A blocked reader returns `document_safe_read_unavailable` and instructs the
model not to retry or bypass the restriction. Request cancellation stops the
read and extraction. PDF and Office parsing use the same packaged libraries
as the other platforms; no Office installation or OCR is required.

PDF parsing runs in a separate Node process on Windows to keep native parser
faults out of the Runtime. Linux/macOS retain their worker-thread boundary.
Both use the same parser, page/text limits and 30-second deadline. Windows
passes documents through pipes, without temporary document files, and waits
for process exit on cancellation. The V8 old-generation limit is 128 MiB,
young-generation at most 16 MiB (4 MiB semi-spaces), and stack 4 MiB. These
are JavaScript engine limits, not a cap on native allocations. Explicit Node CLI flags enforce the heap and stack limits; operator-provided
Node configuration remains inherited.

If Windows cannot start or stop the PDF process, the tool returns
`document_pdf_process_unavailable` and asks the model not to retry or bypass
the restriction.

Office text extraction uses the independent byte-only document-text library via
`src/plugin-sdk/document-text.ts`. That library has no plugin configuration,
Runtime registry, file access or resource index. Disabling this plugin removes
its tool; it does not disable Resources or the shared extraction code. This
plugin retains its own path grants, retained-text budget and tool output contract.
