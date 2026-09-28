import { connectNativeHost } from "../../../computer-access/companion/native-session.js";

// Executed in a fresh Node process so NODE_EXTRA_CA_CERTS uses only the test's CA.
const stop = new AbortController();
const paired: { hostId: string; credential: string }[] = [];
let lookups = 0;
let ready = 0;
const outcome = await connectNativeHost({
  url: process.argv[2]!,
  authorization: "a".repeat(43),
  identity: { name: "TLS fixture", os: "macos", user: "test", homeDir: "/Users/test" },
  signal: stop.signal,
  handlers: {},
  notifications: { ready: false, handlers: () => ({}), close: () => {} },
  resolveHost: async () => {
    lookups++;
    throw new Error("Unexpected external DNS");
  },
  onPaired: async (hostId, credential) => {
    paired.push({ hostId, credential });
    stop.abort();
  },
  onReady: () => { ready++; },
});
process.stdout.write(JSON.stringify({ outcome, paired, lookups, ready }));
