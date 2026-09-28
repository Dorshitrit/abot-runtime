import {
  shellString,
  type CompanionInstallerInput,
} from "./installer-contract.js";

/** Native desktop install; Node and desktop accessibility dependencies remain user-managed. */
export function renderLinuxCompanionScript(
  input: CompanionInstallerInput,
): string {
  const url = new URL(input.url);
  const localAlias =
    url.hostname === "localhost" || url.hostname.endsWith(".localhost");
  const resolve = localAlias
    ? ` --resolve ${shellString(`${url.hostname}:${url.port || "80"}:127.0.0.1`)}`
    : "";
  const payload = JSON.stringify({
    url: input.url,
    code: input.code,
    ...(input.upgradeHostId ? { upgradeHostId: input.upgradeHostId } : {}),
  });
  return `#!/bin/bash
set -euo pipefail
umask 077
if [ "$(uname -s)" != 'Linux' ]; then echo 'Run this setup on the Linux desktop host.' >&2; exit 1; fi
if [ -n "\${WSL_DISTRO_NAME:-}" ]; then echo 'For a Windows desktop, use the Windows companion installer outside WSL.' >&2; exit 1; fi
if [ -z "\${DISPLAY:-}" ] && [ -z "\${WAYLAND_DISPLAY:-}" ]; then echo 'Run this setup from your graphical desktop session.' >&2; exit 1; fi
NODE=$(command -v node || true)
if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then echo 'Node.js 20.19+ or 22.12+ must already be installed on this computer.' >&2; exit 1; fi
"$NODE" -e 'const [major,minor]=process.versions.node.split(".").map(Number); if(!((major===20&&minor>=19)||(major===22&&minor>=12)||major>22))process.exit(1)' || { echo 'The installed Node.js version is unsupported.' >&2; exit 1; }
for TOOL in curl sha256sum mktemp; do command -v "$TOOL" >/dev/null || { echo "Required tool is unavailable: $TOOL" >&2; exit 1; }; done
BASE="\${XDG_DATA_HOME:-$HOME/.local/share}/ABot/HostCompanion"
case "$BASE" in /*) ;; *) echo 'The installation directory must be absolute.' >&2; exit 1 ;; esac
TEMP=''
cleanup() { case "$TEMP" in "$BASE"/setup.*) rm -rf -- "$TEMP" ;; esac; }
trap cleanup EXIT
if [ -L "$BASE" ]; then echo 'The installation directory must not be a link.' >&2; exit 1; fi
mkdir -p "$BASE"
if [ ! -O "$BASE" ]; then echo 'The installation directory must belong to this user.' >&2; exit 1; fi
chmod 700 "$BASE"
BUNDLE="$BASE/companion-${input.bundleSha256}.mjs"
if [ -L "$BUNDLE" ]; then echo 'The companion bundle must not be a link.' >&2; exit 1; fi
if [ ! -f "$BUNDLE" ]; then
  if [ "$(date +%s)" -ge ${Math.floor(Date.parse(input.expiresAt) / 1000)} ]; then echo 'This setup invitation expired. Download a fresh setup file in ABot.' >&2; exit 1; fi
  TEMP=$(mktemp -d "$BASE/setup.XXXXXX")
  PAIRING_CODE=${shellString(input.code)}
  printf 'header = "Authorization: Bearer %s"\n' "$PAIRING_CODE" | curl --config - --fail --show-error --silent --proto '=http' --max-redirs 0 --noproxy '*' --connect-timeout 10 --max-time 120${resolve} --output "$TEMP/companion.mjs" ${shellString(input.url + "/web-api/runtime/system-host/bundle")}
  ACTUAL_SHA=$(sha256sum "$TEMP/companion.mjs"); ACTUAL_SHA=\${ACTUAL_SHA%% *}
  if [ "$ACTUAL_SHA" != '${input.bundleSha256}' ]; then echo 'Companion checksum verification failed. Nothing was executed.' >&2; exit 1; fi
  chmod 600 "$TEMP/companion.mjs"
  mv "$TEMP/companion.mjs" "$BUNDLE"
fi
ACTUAL_SHA=$(sha256sum "$BUNDLE"); ACTUAL_SHA=\${ACTUAL_SHA%% *}
if [ "$ACTUAL_SHA" != '${input.bundleSha256}' ]; then echo 'The installed bundle does not match its checksum.' >&2; exit 1; fi
printf '%s' ${shellString(payload)} | "$NODE" "$BUNDLE" setup
echo 'Companion connected for this user and registered for graphical login. Return to ABot to use the connected computer.'
`;
}
