/** Keep a valid UTF8 code point together when a running process is observed. */
export function incompleteUtf8TailBytes(tail: Uint8Array): number {
  if (tail.length === 0) return 0;
  let lead = tail.length - 1;
  while (lead >= 0 && (tail[lead]! & 0xc0) === 0x80) lead -= 1;
  if (lead < 0) return 0;
  const byte = tail[lead]!;
  let expected = 1;
  if (byte >= 0xc2 && byte <= 0xdf) expected = 2;
  if (byte >= 0xe0 && byte <= 0xef) expected = 3;
  if (byte >= 0xf0 && byte <= 0xf4) expected = 4;
  const available = tail.length - lead;
  return available < expected ? available : 0;
}
