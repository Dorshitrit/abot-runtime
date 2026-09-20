/** Update only active enabled entries inside interop sections, preserving other lines. */
export const WSL_INTEROP_AWK_PROGRAM = String.raw`
function finishSection() {
  if (inInterop && !hasEnabled) print "enabled=true"
}
{
  normalized=$0
  sub(/\r$/, "", normalized)
  lowered=tolower(normalized)
  if (lowered ~ /^[ \t]*\[/) {
    finishSection()
    inInterop=(lowered ~ /^[ \t]*\[interop\][ \t]*([#;].*)?$/)
    if (inInterop) { seenInterop=1; hasEnabled=0 }
    print $0
    next
  }
  if (inInterop && lowered ~ /^[ \t]*enabled[ \t]*=/) {
    hasEnabled=1
    value=lowered
    sub(/^[^=]*=[ \t]*/, "", value)
    sub(/[ \t]*[#;].*$/, "", value)
    sub(/[ \t]*$/, "", value)
    if (value == "true") { print $0; next }
    prefix=normalized
    sub(/=.*/, "=", prefix)
    suffix=normalized
    if (match(suffix, /[#;]/)) suffix=" " substr(suffix, RSTART)
    else suffix=""
    print prefix "true" suffix
    next
  }
  print $0
}
END {
  finishSection()
  if (!seenInterop) { print "[interop]"; print "enabled=true" }
}
`;

export function renderWslInteropShell(): string {
  return `set -eu
config=/etc/wsl.conf
source=/dev/null
if [ -L "$config" ]; then echo 'Refusing to replace a linked /etc/wsl.conf.' >&2; exit 1; fi
if [ -e "$config" ] && [ ! -f "$config" ]; then echo '/etc/wsl.conf is not a regular file.' >&2; exit 1; fi
if [ -f "$config" ]; then
  source="$config"
  backup="$config.abot-before-$(date -u +%Y%m%dT%H%M%SZ)-$$"
  cp -p "$config" "$backup"
  printf 'Original configuration saved to %s\\n' "$backup"
fi
temporary=$(mktemp /etc/.abot-wsl-conf.XXXXXX)
trap 'rm -f "$temporary"' EXIT HUP INT TERM
awk '${WSL_INTEROP_AWK_PROGRAM}' "$source" > "$temporary"
if [ -f "$config" ]; then
  chmod --reference="$config" "$temporary"
  chown --reference="$config" "$temporary"
else
  chmod 644 "$temporary"
fi
if [ -f "$config" ] && cmp -s "$config" "$temporary"; then
  echo 'Interop configuration is already enabled.'
else
  mv -f "$temporary" "$config"
  echo 'Interop configuration enabled; the selected distribution must restart.'
fi
`;
}
