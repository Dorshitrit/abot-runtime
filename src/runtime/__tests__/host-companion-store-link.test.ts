import { expect, test } from "vitest";
import {
  createStoreConnectionLink,
  parseStoreConnectionLink,
  readStoreConnectionInvitation,
  STORE_CONNECTION_LINK_MAX_BYTES,
  type StoreConnectionInvitation,
} from "../../computer-access/companion/windows-store/connection-link.js";
import { WINDOWS_COMPANION_STORE } from "../../computer-access/companion/windows-store/identity.js";
import { COMPANION_RELEASE_VERSION } from "../../computer-access/companion/release-version.js";

const now = Date.parse("2026-10-08T12:00:00.000Z");
const invitation: StoreConnectionInvitation = {
  version: 1,
  url: "http://127.0.0.1:5177",
  code: "secret_pairing_code_".padEnd(43, "a"),
  expiresAt: "2099-10-08T12:15:00.000Z",
  companionRelease: COMPANION_RELEASE_VERSION,
};
const prefix = `${WINDOWS_COMPANION_STORE.protocol}//connect`;
function uncheckedLink(value: unknown): string {
  return `${prefix}?invitation=${Buffer.from(JSON.stringify(value)).toString("base64url")}`;
}
function expectPrivateRejection(link: string): Error {
  try {
    parseStoreConnectionLink(link, now);
    throw new Error("Expected invitation rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    const failure = error as Error;
    expect(failure.message).not.toContain(invitation.code);
    expect(failure.message).not.toContain(link);
    expect(failure.message).not.toBe("Expected invitation rejection");
    return failure;
  }
}

test.each([
  "http://127.0.0.1:5177",
  "http://localhost:5190",
  "http://abot.localhost:5177",
  "http://[::1]:5177",
  "http://[::ffff:127.0.0.1]:5177",
])(
  "round-trips a local invitation at %s without adding installer payloads",
  (url) => {
    const input = {
      ...invitation,
      url,
      upgradeHostId: "317ec6e1-1148-47c7-85a2-dd6acac9fbe2",
    };
    const link = createStoreConnectionLink(input);
    const parsed = parseStoreConnectionLink(link, now);
    expect(parsed).toEqual({ ...input, url: new URL(url).origin });
    expect([...new URL(link).searchParams.keys()]).toEqual(["invitation"]);
    expect(Buffer.byteLength(link)).toBeLessThan(
      STORE_CONNECTION_LINK_MAX_BYTES,
    );
  },
);

test.each([
  "https://127.0.0.1:5177",
  "ws://127.0.0.1:5177",
  "http://192.168.1.1:5177",
  "http://localhost.example:5177",
  "http://user:password@localhost:5177",
  "http://localhost:5177/path",
  "http://localhost:5177?code=private",
  "http://localhost:5177#private",
  "http://local\nhost:5177",
])(
  "rejects unsupported runtime origin %s without leaking the invitation",
  (url) => {
    expectPrivateRejection(uncheckedLink({ ...invitation, url }));
  },
);

test.each([
  null,
  [],
  { ...invitation, extra: true },
  { ...invitation, version: 2 },
  { ...invitation, code: "too_short" },
  { ...invitation, code: "!".repeat(43) },
  { ...invitation, expiresAt: "not-a-date" },
  { ...invitation, companionRelease: 0 },
  { ...invitation, companionRelease: 1.5 },
  { ...invitation, companionRelease: "1" },
  { ...invitation, upgradeHostId: "contains spaces" },
])(
  "rejects malformed invitation data %# without exposing its secret",
  (value) => {
    expectPrivateRejection(uncheckedLink(value));
  },
);

test.each([
  `https://connect?invitation=secret`,
  `${WINDOWS_COMPANION_STORE.protocol}//other?invitation=secret`,
  `${prefix}:123?invitation=secret`,
  `${WINDOWS_COMPANION_STORE.protocol}//user@connect?invitation=secret`,
  `${prefix}/path?invitation=secret`,
  `${prefix}?invitation=secret#fragment`,
  `${prefix}?invitation=secret&invitation=secret`,
  `${prefix}?invitation=secret&other=true`,
  `${prefix}?other=secret`,
  `${prefix}?invitation=bad!base64`,
  `${prefix}?invitation=${Buffer.from("not-json").toString("base64url")}`,
  `${prefix}?invitation=${"a".repeat(STORE_CONNECTION_LINK_MAX_BYTES)}`,
])(
  "rejects malformed activation link %# without exposing its payload",
  (link) => {
    expectPrivateRejection(link);
  },
);

test("expiry is rejected at the boundary and a future invitation remains usable", () => {
  const expiresAt = new Date(now).toISOString();
  expect(
    expectPrivateRejection(uncheckedLink({ ...invitation, expiresAt })).message,
  ).toContain("expired");
  expect(
    readStoreConnectionInvitation(
      {
        ...invitation,
        expiresAt: new Date(now + 1).toISOString(),
      },
      now,
    ).code,
  ).toBe(invitation.code);
});

test("a newer required companion release asks for a Store update while older compatible invitations remain usable", () => {
  const error = expectPrivateRejection(
    uncheckedLink({
      ...invitation,
      companionRelease: COMPANION_RELEASE_VERSION + 1,
    }),
  );
  expect(error.message).toContain("Microsoft Store");
  expect(
    parseStoreConnectionLink(
      uncheckedLink({
        ...invitation,
        companionRelease: 1,
      }),
      now,
    ).companionRelease,
  ).toBe(1);
});
