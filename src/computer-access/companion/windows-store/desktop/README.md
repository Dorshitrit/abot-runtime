# Windows Store desktop shell

This small WinForms application is the Windows presentation layer. It does not
own pairing, permissions, credentials, reconnect policy or protocol validation.
The bundled Node entry owns those behaviors through the shared Companion code.

The package places `ABotCompanion.exe`, `node.exe` and `companion.mjs` together.
Compile the C# 5 sources with the .NET Framework compiler, referencing
`System.Windows.Forms.dll`, `System.Drawing.dll` and `System.Web.Extensions.dll`.
The build needs no NuGet packages. The application targets Windows 10/11.

- Normal activation opens connection status and explicit user actions.
- `abot-companion:` activation passes the invitation to `inspect-link` on stdin,
  shows the verified runtime origin, then calls `setup-link` after confirmation.
- `abot:` activation calls `open-plugin-link` on stdin. The shared Node handler
  binds this existing install-link flow to the saved pairing.
- `--background` starts the existing `host run` process without a window.
- Disconnect calls the existing Node lifecycle. Closing the window leaves an
  active connection running. Windows owns the startup preference.

Helper command names are fixed; invitation values never become helper arguments.
Captured stdout and stderr are separately bounded, helpers have timeouts, and
native errors never display captured output or raw invitation values. No GUI
launch, pairing, startup registration or installation is part of compilation.
