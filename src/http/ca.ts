import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type CertificateAuthority = {
  certPath: string;
  confDirPath: string;
};

export async function createCertificateAuthority(): Promise<CertificateAuthority> {
  const confDirPath = await mkdtemp(join(tmpdir(), "sandy-mitmproxy-conf-"));
  const keyPath = join(confDirPath, "ca.key");
  const certPath = join(confDirPath, "mitmproxy-ca-cert.pem");
  const combinedPemPath = join(confDirPath, "mitmproxy-ca.pem");

  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", keyPath,
    "-out", certPath,
    "-days", "365",
    "-subj", "/CN=Sandy Root CA/O=Sandy",
    "-addext", "keyUsage=critical,keyCertSign,cRLSign",
    "-addext", "basicConstraints=critical,CA:TRUE",
  ], { stdio: "ignore" });

  const [key, cert] = await Promise.all([
    readFile(keyPath, "utf8"),
    readFile(certPath, "utf8"),
  ]);

  await writeFile(combinedPemPath, `${key}${cert}`, "utf8");

  const workerCertPath = join(confDirPath, `sandy-ca-${randomUUID()}.pem`);
  await writeFile(workerCertPath, cert, "utf8");

  return {
    certPath: workerCertPath,
    confDirPath,
  };
}
