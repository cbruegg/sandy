import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type CertificateAuthority = {
  cert: string;
  key: string;
  certPath: string | null;
};

export async function createCertificateAuthority(): Promise<CertificateAuthority> {
  const dir = await mkdtemp(join(tmpdir(), "sandy-ca-"));
  const keyPath = join(dir, "ca.key");
  const certPath = join(dir, "ca.pem");

  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", keyPath,
    "-out", certPath,
    "-days", "365",
    "-subj", "/CN=Sandy Root CA/O=Sandy",
  ], { stdio: "ignore" });

  const key = execFileSync("cat", [keyPath], { encoding: "utf8" });
  const cert = execFileSync("cat", [certPath], { encoding: "utf8" });

  // Keep the cert on disk for worker mounting
  const persistCertPath = join(tmpdir(), `sandy-ca-${randomUUID()}.pem`);
  await writeFile(persistCertPath, cert, "utf8");

  // Clean up the temp key directory
  await rm(dir, { recursive: true, force: true });

  return {
    cert,
    key,
    certPath: persistCertPath,
  };
}

export function createLeafCertificate(
  caCert: string,
  caKey: string,
  hostname: string,
): { cert: string; key: string } {
  const dir = mkdtempSync(join(tmpdir(), "sandy-leaf-"));
  const caCertPath = join(dir, "ca.pem");
  const caKeyPath = join(dir, "ca.key");
  const leafKeyPath = join(dir, "leaf.key");
  const leafCsrPath = join(dir, "leaf.csr");
  const leafCertPath = join(dir, "leaf.pem");
  const extPath = join(dir, "leaf.ext");

  writeFileSync(caCertPath, caCert, "utf8");
  writeFileSync(caKeyPath, caKey, "utf8");
  writeFileSync(extPath, `subjectAltName = DNS:${hostname}\n`, "utf8");

  execFileSync("openssl", [
    "req", "-newkey", "rsa:2048", "-nodes",
    "-keyout", leafKeyPath,
    "-out", leafCsrPath,
    "-subj", `/CN=${hostname}`,
  ], { stdio: "ignore" });

  execFileSync("openssl", [
    "x509", "-req",
    "-in", leafCsrPath,
    "-CA", caCertPath,
    "-CAkey", caKeyPath,
    "-CAcreateserial",
    "-out", leafCertPath,
    "-days", "1",
    "-extfile", extPath,
  ], { stdio: "ignore" });

  const leafKey = execFileSync("cat", [leafKeyPath], { encoding: "utf8" });
  const leafCert = execFileSync("cat", [leafCertPath], { encoding: "utf8" });

  rmSync(dir, { recursive: true, force: true });

  return { cert: leafCert, key: leafKey };
}
