import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

/** Ephemeral test identity; neither certificates nor private keys enter source control. */
export async function nativeLoopbackCertificate() {
  const parent = join(process.cwd(), ".codex/artifacts/macos-loopback-review-20260928");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, "tls-"));
  const cleanup = () => rm(directory, { recursive: true, force: true });
  try {
    const config = join(directory, "openssl.cnf");
    const keyPath = join(directory, "key.pem");
    const certPath = join(directory, "cert.pem");
    await writeFile(config, `[req]
prompt = no
distinguished_name = identity
x509_extensions = server
[identity]
CN = localhost
[server]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = DNS:localhost,DNS:abot.localhost
`);
    await promisify(execFile)("openssl", ["req", "-new", "-x509", "-nodes", "-newkey",
      "rsa:2048", "-sha256", "-days", "1", "-config", config,
      "-keyout", keyPath, "-out", certPath], { timeout: 15_000 });
    const [key, cert] = await Promise.all([readFile(keyPath), readFile(certPath)]);
    return { key, cert, certPath, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
