# Windows Companion Store delivery

## Current status

**ABot AI Companion** is available from
[Microsoft Store](https://apps.microsoft.com/detail/9PK2FDQQLQS9), product ID
`9PK2FDQQLQS9`. Runtime 1.7.0 provides the guided connection flow described below.

The Store app and Runtime have separate releases.

## Connection experience

The Web UI links to the Store for one installation. The user returns to ABot,
requests a connection link and explicitly opens Companion. Companion shows the
Runtime address and asks for confirmation before pairing. Users who already
installed Companion go directly to connecting. The Web UI confirms the live
connection after pairing.

Before **Allow connection** is enabled, users must select an initially unchecked
acknowledgment of the described computer access and data sharing. The dialog
links to the [software terms](https://abot-ai.com/terms/#software) and
[privacy policy](https://abot-ai.com/privacy/#software); opening either link does
not grant consent. Task permissions and optional SPARK controls remain separate.
Disconnecting does not erase data already sent to the Runtime or other services.

For a paired computer that is offline, **Open Companion** uses the fixed
`abot-companion://open` activation without creating an invitation. It opens the
saved connection or explains how to re-pair when local credentials are missing.
**Set up again** requires confirmation, revokes the old server pairing using
the existing endpoint, then requests a fresh invitation. An upgrade invitation
never substitutes for a new pairing grant when local credentials are missing.
After explicit consent, a fresh connection consumes the new grant even when an
old local credential remains. The previous owned process is stopped before that
exchange. A failed exchange preserves the saved credential but does not restart
the previous process;
an upgrade continues to use the matching saved host identity.

Every user installs the same package. The personalized, expiring invitation is
sent through the `abot-companion:` protocol after installation. It carries the
existing pairing or upgrade grant, not a second authentication scheme. The Web UI
keeps it only in the current surface, clears it after connection or expiry, and
does not save it to browser storage. Do not put connection links in logs, support
reports or screenshots.

The current invitation contract accepts a local HTTP loopback Runtime address.
Docker must publish its Web UI port on the Windows host's loopback; other setups
must expose the Runtime through an appropriate local forward. Opening ABot on a
different computer does not make that remote Runtime address a valid invitation.

## Shared components

| Owner | Responsibility |
| --- | --- |
| Shared Web UI connection manager | Connection status, readiness polling, unpairing and onboarding lifecycle. |
| Windows Store UI module and route | Store link, temporary invitation and explicit launch. The route uses the existing pairing store. |
| Windows desktop shell | Display connection status and consent, activate links and call the bundled Node entry. |
| Shared Companion and CLI lifecycle | Pairing credentials, command and desktop capabilities, connection protocol, reconnect behavior and permission checks. |
| Windows Store lifecycle adapter and MSIX package | Windows package activation, startup integration, notification identity and package updates. |

The desktop shell does not implement another pairing store or copy the Companion
protocol. Shared fixes belong in the shared Companion implementation; Windows
presentation and package integration stay in the Windows adapter. The package
contains the runtime dependencies needed for connection.

The Store integration changes Windows delivery. Native macOS connection, manual
Mac connection, Linux setup and WSL command routing keep their existing owners
and behavior. A WSL Runtime can use the Windows desktop Companion without a WSL
restart.

## Version and update ownership

The **MSIX package version** orders Windows package updates. The **Companion
release version**, owned by `src/computer-access/companion/release-version.ts`,
describes the Companion behavior expected by the Runtime. These are different
values: a packaging or shell-only rebuild can require a newer MSIX version
without changing the Companion release contract.

If the Runtime requires a Companion release newer than the installed package,
the invitation is rejected with a request to update through Microsoft Store.
The Store supplies the replacement package; the Runtime does not overwrite
Store-owned executable files. Store updates are intended to preserve the user's
saved pairing.

The Store identity is owned by
`src/computer-access/companion/windows-store/identity.ts`. Packaging and the
Companion must use this same identity. Do not create another copy of protocol
version or package identity policy in the Web UI or desktop shell.

## Build from source

Build Companion from this repository.
The build uses the pinned Windows Node.js distributions, checking the archive
hash before extracting only `node.exe` and its license. Supply an explicit
four-part Store version with a zero last component.

```sh
npx tsx scripts/build-windows-companion-store.ts \
  --output-dir <new-layout-directory> \
  --node-archive <verified-node-windows-zip> \
  --version <major.minor.patch.0> --architecture x64
```

Then, in Windows PowerShell, use the .NET Framework compiler and an authentic
Microsoft Windows SDK `MakeAppx.exe`:

```powershell
./scripts/build-windows-companion-store.ps1 `
  -LayoutDirectory <layout-directory> `
  -MakeAppxPath <local-windows-sdk-makeappx-path> `
  -OutputPath <new-msix-path>
```

Keep the SDK tools on a local Windows volume. Package inputs and output can
remain in the WSL checkout. The output is unsigned and is not installed,
registered, signed or submitted by these scripts.

## Package contents

The public source includes the Windows shell and packaging scripts. The MSIX
contains the compiled shell, bundled shared Companion, pinned Node executable,
licenses, icons and Windows manifest. The Store package and Node executable are
not part of the Runtime npm package.

Pairing invitations are generated when the user requests a connection. They are
never baked into the Store package. Local configurations, API keys, saved pairing
and logs must stay outside the Store package. Store product and publisher identity
values are public package metadata, not authentication credentials.
