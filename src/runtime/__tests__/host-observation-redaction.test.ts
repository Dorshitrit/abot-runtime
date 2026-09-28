import { describe, expect, test } from "vitest";
import { redactObservationText } from "../../computer-access/companion/observation-redaction.js";
import { observationRedactionTransportCases } from "./support/host-observation-redaction-transport-cases.js";

const REDACTED = "[REDACTED]";
const encodeHeader = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

function expectFieldMasked(input: string): void {
  expect(redactObservationText(input)).toBe(REDACTED);
  expect(redactObservationText(REDACTED)).toBe(REDACTED);
}

describe("whole observation field redaction", () => {
  test.each([
    "password",
    "passwd",
    "pwd",
    "api_key",
    "access-token",
    "refresh_token",
    "client secret",
    "recovery_code",
    "AWS_SECRET_ACCESS_KEY",
    "OPENAI_API_KEY",
    "DATABASE_PASSWORD",
    "X_VENDOR-API_Key",
    "database.password",
    "auth.access_token",
    "--password",
    "-api-key",
    "Authorization",
    "Proxy-Authorization",
  ])("masks the entire field for known label %s", (label) => {
    for (const separator of [":", "="]) {
      expectFieldMasked(
        `Ordinary prefix\n${label}${separator}synthetic-secret\nOrdinary suffix`,
      );
      expectFieldMasked(`${label}${separator}`);
      expectFieldMasked(`${label}${separator} [malformed or incomplete`);
    }
  });

  test.each(observationRedactionTransportCases)(
    "treats credential-bearing captured text as an opaque field: %s",
    expectFieldMasked,
  );

  test.each([
    String.raw`{"pass\u0077ord":"synthetic-secret","name":"safe"}`,
    String.raw`"pass\x77ord": synthetic-secret`,
    String.raw`"pass\U00000077ord": synthetic-secret`,
    String.raw`{"Auth\u006frization":"Custom synthetic-secret"}`,
    String.raw`"Proxy\u002dAuthorization": synthetic-secret`,
    String.raw`{"X\u002dAPI\u002dKey":"synthetic-secret"}`,
    String.raw`{"database.pass\u0077ord":"synthetic-secret"}`,
    String.raw`'pass\u0077ord': synthetic-secret`,
    "%22pass%5Cu0077ord%22%3A%20synthetic-secret",
    "https://example.test/?api%5fkey=synthetic-secret&name=safe",
    "https://example.test/?%70%77%64%3Dsynthetic-secret",
  ])(
    "recognizes existing percent and ASCII-escaped indicators: %s",
    expectFieldMasked,
  );

  test.each([
    "https://alice:synthetic-secret@example.test/path?name=safe",
    "https://alice:p%40ss%20word@example.test/path",
    "https://user%2Fname:synthetic-secret%40example.test/path",
    "https%3A%2F%2Fuser%2Fname:fixture_secret@example.test",
    "https%3A//user%23name:fixture_secret%40example.test",
    "https://alice@example.test/path",
    "Before Basic dXNlcjpwYXNz after",
    "Before Bearer synthetic-credential after",
    "Bearer%20abc%2Fdef",
  ])("recognizes URL userinfo and HTTP credentials: %s", expectFieldMasked);

  // Assemble synthetic credentials so source scanners do not mistake fixtures for live keys.
  test.each([
    "sk-proj-" + "abcdefghijklmnopqrst0123456789",
    "sk-" + "abcdefghijklmnopqrst0123456789",
    "ghp_" + "abcdefghijklmnopqrst0123456789",
    "github_pat_" + "abcdefghijklmnopqrst0123456789",
    "xoxb-" + "1234567890-1234567890-abcdefghijklmnopqrst",
    "AKIA" + "1234567890ABCDEF",
    "ASIA" + "1234567890ABCDEF",
  ])("recognizes existing provider token category %s", (token) => {
    expectFieldMasked(`Before ${token}; after`);
  });

  test.each([
    "sk-proj-frag",
    "ghp_frag",
    "github_pat_frag",
    "xoxb-frag",
    "AKIA1234",
  ])("recognizes an existing token prefix at the capture end: %s", (token) =>
    expectFieldMasked(`Before ${token}`),
  );

  test("recognizes JWS, terminal partial capture, and token boundaries", () => {
    const header = encodeHeader({ alg: "HS256", typ: "JWT" });
    const claims = encodeHeader({ sub: "fixture" });
    for (const token of [
      `${header}.${claims}.signature`,
      `${header}.${claims}`,
    ])
      expectFieldMasked(`Before ${token}`);
    expectFieldMasked(`prefix.${header}.${claims}.signature.suffix after`);
  });

  test.each(["dir", "RSA-OAEP"])("recognizes compact JWE using %s", (alg) => {
    const header = encodeHeader({ alg, enc: "A256GCM" });
    const key = alg === "dir" ? "" : "encrypted-key";
    const token = `${header}.${key}.iv.ciphertext.tag`;
    for (const field of [
      token,
      token.replaceAll(".", "%2E"),
      `prefix.${token}.suffix`,
    ])
      expectFieldMasked(field);
    expectFieldMasked(`${header}.${key}.iv.ciphertext`);
    const formatted = Buffer.from(
      ` { "enc":"A256GCM", "alg":"${alg}" }`,
    ).toString("base64url");
    expectFieldMasked(`${formatted}.${key}.iv..tag`);
  });

  test.each([
    "PRIVATE KEY",
    "RSA PRIVATE KEY",
    "EC PRIVATE KEY",
    "OPENSSH PRIVATE KEY",
    "ENCRYPTED PRIVATE KEY",
    "PGP PRIVATE KEY BLOCK",
  ])("recognizes complete and partial %s blocks", (kind) => {
    const opening = ["-----BEGIN", `${kind}-----`].join(" ");
    expectFieldMasked(
      `Before\n${opening}\nsynthetic body\n-----END ${kind}-----\nAfter`,
    );
    expectFieldMasked(`Before\n${opening}\npartial body`);
  });

  test.each([
    "",
    REDACTED,
    "A normal project note. טיוטה רגילה.",
    "https://example.test/docs?query=ordinary&name=alice#section",
    "Basic knowledge and password policies matter.",
    "Token budgets and authorization policies matter.",
    "X-Authorization: Custom ordinary\nAuthorization status: approved",
    "password_length=12; access_token_count=3",
    "X-API-Key-Count: 3; X-API-Key_ID: safe; MY-PASSWORD_LENGTH=12",
    "database.password_policy=ordinary; service.api_key.count=3",
    "https://example.test/?api+key=ordinary",
    String.raw`{"pass\\u0077ord":"literal-backslash"}`,
    String.raw`{"pass\u00ZZord":"malformed-escape"}`,
    String.raw`{"pass\u0022word":"unrelated-key"}`,
  ])("preserves fields without a known indicator: %s", (input) => {
    expect(redactObservationText(input)).toBe(input);
  });

  test.each([
    { name: "ordinary" },
    { alg: "dir" },
    { alg: 256, enc: "A256GCM" },
  ])("preserves non-JOSE dotted text with header %j", (header) => {
    const input = `${encodeHeader(header)}..iv.ordinary.words`;
    expect(redactObservationText(input)).toBe(input);
  });

  test("does not infer an unknown secret from arbitrary unlabelled text", () => {
    const input = "Private note: a8Zx2Nq4Rw7Bj5Lp9Vc6Tm3Ks1Hd0FgE";
    expect(redactObservationText(input)).toBe(input);
  });

  test("a credential marker also masks otherwise ordinary surrounding text", () => {
    expectFieldMasked(
      "טיוטה רגילה\npassword=[REDACTED]\nAnother ordinary line",
    );
  });
});
