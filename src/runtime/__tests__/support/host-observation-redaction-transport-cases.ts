/** Opaque captured fields: internal value syntax never controls the redaction boundary. */
export const observationRedactionTransportCases = [
  "Ordinary heading\npassword=transport-secret\nOrdinary ending",
  '{"cmd":"tool \'--password=first transport-secret\'","name":"safe"}',
  "tool --password=<(printf transport-secret) --name=safe",
  "tool --password=>(printf transport-secret) --name=safe",
  "password:\n  first transport-secret\n  continuation\nname: safe",
  "headers:\n  Authorization: >2-\n    Custom transport-secret\n  X-Trace: safe",
  '[password: "transport-secret", ordinary: "safe"]',
  '{"password":["transport-secret",{"nested":"other text"}],"name":"safe"}',
  'password = """first transport-secret\nsecond line"""\nname = "safe"',
  "tool --password=$'first\\' transport-secret' --name=safe",
  "env PASSWORD=correct\\ transport-secret tool",
  String.raw`{"pass\u0077ord":"transport-secret","name":"safe"}`,
  String.raw`"Auth\u006frization": Custom transport-secret`,
  "https://example.test/?api%5fkey=transport-secret&name=safe",
  "tool --password= --name=safe",
];
