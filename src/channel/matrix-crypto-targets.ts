type MatrixTargetRecord = {
  target: string;
  binaryName: string;
};

const matrixTargetRecords: MatrixTargetRecord[] = [
  { target: "bun-linux-x64", binaryName: "matrix-sdk-crypto.linux-x64-gnu.node" },
  { target: "bun-linux-x64-baseline", binaryName: "matrix-sdk-crypto.linux-x64-gnu.node" },
  { target: "bun-linux-x64-modern", binaryName: "matrix-sdk-crypto.linux-x64-gnu.node" },
  { target: "bun-linux-arm64", binaryName: "matrix-sdk-crypto.linux-arm64-gnu.node" },
  { target: "bun-linux-x64-musl", binaryName: "matrix-sdk-crypto.linux-x64-musl.node" },
  { target: "bun-darwin-x64", binaryName: "matrix-sdk-crypto.darwin-x64.node" },
  { target: "bun-darwin-arm64", binaryName: "matrix-sdk-crypto.darwin-arm64.node" },
  { target: "bun-windows-x64", binaryName: "matrix-sdk-crypto.win32-x64-msvc.node" },
  { target: "bun-windows-x64-baseline", binaryName: "matrix-sdk-crypto.win32-x64-msvc.node" },
  { target: "bun-windows-x64-modern", binaryName: "matrix-sdk-crypto.win32-x64-msvc.node" },
  { target: "bun-windows-arm64", binaryName: "matrix-sdk-crypto.win32-arm64-msvc.node" },
];

export function resolveMatrixCryptoBinaryName(platform: NodeJS.Platform, arch: string): string {
  switch (platform) {
    case "darwin":
      if (arch === "arm64") {
        return "matrix-sdk-crypto.darwin-arm64.node";
      }
      if (arch === "x64") {
        return "matrix-sdk-crypto.darwin-x64.node";
      }
      break;
    case "linux":
      if (arch === "x64") {
        return "matrix-sdk-crypto.linux-x64-gnu.node";
      }
      if (arch === "arm64") {
        return "matrix-sdk-crypto.linux-arm64-gnu.node";
      }
      if (arch === "arm") {
        return "matrix-sdk-crypto.linux-arm-gnueabihf.node";
      }
      break;
    case "win32":
      if (arch === "x64") {
        return "matrix-sdk-crypto.win32-x64-msvc.node";
      }
      if (arch === "ia32") {
        return "matrix-sdk-crypto.win32-ia32-msvc.node";
      }
      if (arch === "arm64") {
        return "matrix-sdk-crypto.win32-arm64-msvc.node";
      }
      break;
  }

  throw new Error(`Unsupported platform for Matrix crypto binding download: ${platform}/${arch}`);
}

export function resolveMatrixCryptoBinaryNameForBunTarget(target: string): string {
  const record = matrixTargetRecords.find((entry) => entry.target === target);
  if (!record) {
    throw new Error(`Unsupported Bun compile target for Matrix crypto bundling: ${target}`);
  }
  return record.binaryName;
}

export function listMatrixCryptoBinaryNamesForCompile(): string[] {
  return Array.from(new Set(matrixTargetRecords.map((entry) => entry.binaryName)));
}
