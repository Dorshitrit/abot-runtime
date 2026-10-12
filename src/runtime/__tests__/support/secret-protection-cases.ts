import { observationRedactionTransportCases } from "./host-observation-redaction-transport-cases.js";

type SecretProtectionCase = Readonly<{ name: string; input: string; expected: string }>;
const masked = (name: string, input: string): SecretProtectionCase => ({ name, input, expected: "[REDACTED]" });
const retained = (name: string, input: string): SecretProtectionCase => ({ name, input, expected: input });
const joseHeader = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const jwsHeader = joseHeader({ alg: "HS256", typ: "JWT" });
const claims = joseHeader({ sub: "synthetic-fixture" });
const jweHeader = joseHeader({ alg: "dir", enc: "A256GCM" });

// Test-only behavior contract: production owners never import this corpus or each other.
export const secretProtectionCases: readonly SecretProtectionCase[] = [
  ...[
    "password", "passwd", "pwd", "api_key", "access-token", "refresh_token",
    "client secret", "recovery_code", "AWS_SECRET_ACCESS_KEY", "OPENAI_API_KEY",
    "DATABASE_PASSWORD", "X_VENDOR-API_Key", "database.password", "auth.access_token",
    "--password", "-api-key", "Authorization", "Proxy-Authorization",
  ].flatMap((label) => [":", "="].flatMap((separator) => [
    masked("label " + label + separator, "Ordinary prefix\n" + label + separator + "synthetic-secret\nOrdinary suffix"),
    masked("empty value " + label + separator, label + separator),
    masked("unfinished value " + label + separator, label + separator + " [incomplete"),
  ])),
  ...observationRedactionTransportCases.map((input, index) => masked("opaque transport field " + index, input)),
  ...[
    '{"pass\\u0077ord":"synthetic-secret","name":"safe"}',
    '"pass\\x77ord": synthetic-secret',
    '"pass\\U00000077ord": synthetic-secret',
    '{"Auth\\u006frization":"Custom synthetic-secret"}',
    '"Proxy\\u002dAuthorization": synthetic-secret',
    '{"X\\u002dAPI\\u002dKey":"synthetic-secret"}',
    '{"database.pass\\u0077ord":"synthetic-secret"}',
    "%22pass%5Cu0077ord%22%3A%20synthetic-secret",
    "https://example.test/?api%5fkey=synthetic-secret&name=safe",
    "https://example.test/?%70%77%64%3Dsynthetic-secret",
  ].map((input, index) => masked("encoded indicator " + index, input)),
  ...[
    "https://alice:synthetic-secret@example.test/path?name=safe",
    "https://alice:p%40ss%20word@example.test/path",
    "https://user%2Fname:synthetic-secret%40example.test/path",
    "https%3A%2F%2Fuser%2Fname:fixture_secret@example.test",
    "https%3A//user%23name:fixture_secret%40example.test",
    "https://alice@example.test/path",
    "Before Basic dXNlcjpwYXNz after",
    "Before Bearer synthetic-credential after",
    "Bearer%20abc%2Fdef",
  ].map((input, index) => masked("URL or HTTP credential " + index, input)),
  // Assemble synthetic provider values so secret scanners do not mistake them for live keys.
  ...[
    ["sk-", "abcdefghijklmnopqrst0123456789"],
    ["sk-proj-", "abcdefghijklmnopqrst0123456789"],
    ["sk-svcacct-", "abcdefghijklmnopqrst0123456789"],
    ["ghp_", "abcdefghijklmnopqrst0123456789"],
    ["github_pat_", "abcdefghijklmnopqrst0123456789"],
    ["xoxb-", "1234567890-1234567890-abcdefghijklmnopqrst"],
    ["AKIA", "1234567890ABCDEF"],
    ["ASIA", "1234567890ABCDEF"],
  ].map(([prefix, value], index) => masked("provider token " + index, "Before " + prefix + value + "; after")),
  ...["sk-proj-frag", "ghp_frag", "github_pat_frag", "xoxb-frag", "AKIA1234"]
    .map((token, index) => masked("terminal provider fragment " + index, "Before " + token)),
  masked("complete JWS", "Before " + jwsHeader + "." + claims + ".signature; after"),
  masked("terminal partial JWS", "Before " + jwsHeader + "." + claims),
  masked("embedded JWS", "prefix." + jwsHeader + "." + claims + ".signature.suffix after"),
  masked("direct compact JWE", jweHeader + "..iv.ciphertext.tag"),
  masked("percent encoded compact JWE", (jweHeader + "..iv.ciphertext.tag").replaceAll(".", "%2E")),
  masked("terminal partial compact JWE", jweHeader + "..iv.ciphertext"),
  masked("RSA compact JWE", joseHeader({ alg: "RSA-OAEP", enc: "A256GCM" }) + ".key.iv.ciphertext.tag"),
  ...["PRIVATE KEY", "RSA PRIVATE KEY", "EC PRIVATE KEY", "OPENSSH PRIVATE KEY",
    "ENCRYPTED PRIVATE KEY", "PGP PRIVATE KEY BLOCK"].flatMap((kind) => {
    const opening = ["-----BEGIN", kind + "-----"].join(" ");
    return [
      masked("complete " + kind, "Before\n" + opening + "\nsynthetic body\n-----END " + kind + "-----\nAfter"),
      masked("partial " + kind, "Before\n" + opening + "\npartial body"),
    ];
  }),
  masked("indicator beyond ordinary excerpt", "ordinary ".repeat(4_000) + "\npassword=synthetic-secret"),
  masked("already masked credential still masks surrounding field", "Ordinary\npassword=[REDACTED]\nOther ordinary"),
  ...[
    "", "[REDACTED]", "A normal project note. טיוטה רגילה.",
    "https://example.test/docs?query=ordinary&name=alice#section",
    "Basic knowledge and password policies matter.",
    "Token budgets and authorization policies matter.",
    "X-Authorization: Custom ordinary\nAuthorization status: approved",
    "password_length=12; access_token_count=3",
    "X-API-Key-Count: 3; X-API-Key_ID: safe; MY-PASSWORD_LENGTH=12",
    "database.password_policy=ordinary; service.api_key.count=3",
    "https://example.test/?api+key=ordinary",
    '{"pass\\\\u0077ord":"literal-backslash"}',
    '{"pass\\u00ZZord":"malformed-escape"}',
    '{"pass\\u0022word":"unrelated-key"}',
    "sk-frag", "ghp_frag after", "AKIA1234 after", "Basic b3JkaW5hcnk=",
    "Private note: a8Zx2Nq4Rw7Bj5Lp9Vc6Tm3Ks1Hd0FgE",
  ].map((input, index) => retained("ordinary or outside detection " + index, input)),
  ...[{ name: "ordinary" }, { alg: "dir" }, { alg: 256, enc: "A256GCM" }]
    .map((header, index) => retained("non-JOSE header " + index, joseHeader(header) + "..iv.ordinary.words")),
];
