import {
  shellString,
  type CompanionInstallerInput,
} from "./installer-contract.js";
import {
  COMPANION_NODE_DISTRIBUTIONS,
  COMPANION_NODE_VERSION,
} from "./node-distribution.js";

export function renderMacCompanionScript(
  input: CompanionInstallerInput,
): string {
  const url = new URL(input.url);
  const localAlias =
    url.hostname === "localhost" || url.hostname.endsWith(".localhost");
  const resolve = localAlias
    ? ` --resolve ${shellString(`${url.hostname}:${url.port || "80"}:127.0.0.1`)}`
    : "";
  const payload = JSON.stringify({ url: input.url, code: input.code });
  return `#!/bin/bash
set -euo pipefail
umask 077
BASE="$HOME/Library/Application Support/ABot/HostCompanion"
TEMP=''
cleanup() {
  case "$TEMP" in "$BASE"/setup.*) /bin/rm -rf -- "$TEMP" ;; esac
}
failed() { echo 'Setup did not complete. Review the error above, then obtain a fresh setup file if needed.' >&2; }
trap cleanup EXIT
trap failed ERR
verify_installation_directory() {
  if [ -L "$BASE" ]; then echo 'The installation directory must not be a link.' >&2; exit 1; fi
  if [ ! -O "$BASE" ]; then echo 'The installation directory must belong to this user.' >&2; exit 1; fi
}
run_verified_companion_setup() {
  if [ ! -f "$NODE" ]; then echo 'The cached Node.js runtime is missing. Restore this installation before resuming setup.' >&2; exit 1; fi
  if [ ! -f "$BUNDLE" ]; then echo 'The cached companion bundle is missing. Restore this installation before resuming setup.' >&2; exit 1; fi
  verify_installation_directory
  if [ "$("$NODE" --version)" != '${COMPANION_NODE_VERSION}' ]; then echo 'The dedicated Node.js runtime could not be verified.' >&2; exit 1; fi
  EXISTING_SHA=$(/usr/bin/shasum -a 256 "$BUNDLE" | /usr/bin/awk '{print $1}')
  if [ "$EXISTING_SHA" != '${input.bundleSha256}' ]; then echo 'The existing companion bundle does not match its checksum.' >&2; exit 1; fi
  echo 'Connecting this computer and enabling startup at sign-in...'
  printf '%s' ${shellString(payload)} | "$NODE" "$BUNDLE" setup
  echo 'Companion setup completed. Return to ABot to check the computer connection.'
}
case "$(/usr/bin/uname -m)" in
  arm64) ARCH='arm64'; NODE_SHA='${COMPANION_NODE_DISTRIBUTIONS["darwin-arm64"].sha256}' ;;
  x86_64) ARCH='x64'; NODE_SHA='${COMPANION_NODE_DISTRIBUTIONS["darwin-x64"].sha256}' ;;
  *) echo 'This Mac architecture is not supported by companion setup.' >&2; exit 1 ;;
esac
NODE_NAME="node-${COMPANION_NODE_VERSION}-darwin-$ARCH"
NODE="$BASE/$NODE_NAME/bin/node"
BUNDLE="$BASE/companion-${input.bundleSha256}.mjs"
if [ -e "$HOME/.abot/host-companion/connection.json" ]; then
  run_verified_companion_setup
  exit 0
fi
if [ "$(/bin/date +%s)" -ge ${Math.floor(Date.parse(input.expiresAt) / 1000)} ]; then
  echo 'This setup invitation expired. Download a fresh setup file in ABot.' >&2
  exit 1
fi
if [ -L "$BASE" ]; then echo 'The installation directory must not be a link.' >&2; exit 1; fi
/bin/mkdir -p "$BASE"
verify_installation_directory
/bin/chmod 700 "$BASE"
TEMP=$(/usr/bin/mktemp -d "$BASE/setup.XXXXXX")
if [ ! -f "$NODE" ]; then
  echo 'Downloading the verified per-user Node.js runtime...'
  /usr/bin/curl --fail --show-error --silent --proto '=https' --tlsv1.2 --max-redirs 0 --connect-timeout 15 --max-time 300 --output "$TEMP/node.tar.gz" "https://nodejs.org/dist/${COMPANION_NODE_VERSION}/$NODE_NAME.tar.gz"
  ACTUAL_SHA=$(/usr/bin/shasum -a 256 "$TEMP/node.tar.gz" | /usr/bin/awk '{print $1}')
  if [ "$ACTUAL_SHA" != "$NODE_SHA" ]; then echo 'Node.js checksum verification failed.' >&2; exit 1; fi
  /usr/bin/tar -xzf "$TEMP/node.tar.gz" -C "$TEMP"
  /bin/mv "$TEMP/$NODE_NAME" "$BASE/$NODE_NAME"
fi
echo 'Downloading and verifying the ABot companion...'
PAIRING_CODE=${shellString(input.code)}
printf 'header = "Authorization: Bearer %s"\n' "$PAIRING_CODE" | /usr/bin/curl --config - --fail --show-error --silent --proto '=http' --max-redirs 0 --noproxy '*' --connect-timeout 10 --max-time 120${resolve} --output "$TEMP/companion.mjs" ${shellString(input.url + "/web-api/runtime/system-host/bundle")}
ACTUAL_SHA=$(/usr/bin/shasum -a 256 "$TEMP/companion.mjs" | /usr/bin/awk '{print $1}')
if [ "$ACTUAL_SHA" != '${input.bundleSha256}' ]; then echo 'Companion checksum verification failed. Nothing was executed.' >&2; exit 1; fi
/bin/chmod 600 "$TEMP/companion.mjs"
if [ ! -e "$BUNDLE" ]; then /bin/mv "$TEMP/companion.mjs" "$BUNDLE"; fi
run_verified_companion_setup
`;
}
