import {mkdir} from "node:fs/promises";
import {relative, resolve} from "node:path";

export async function createBundleSharePath(shareRoot: string, bundleId: string): Promise<string> {
  const root = resolve(shareRoot);
  const sharePath = resolve(root, `bundle-${bundleId}`);
  const relativePath = relative(root, sharePath);

  if (relativePath.startsWith("..") || relativePath === "" || relativePath.startsWith("/")) {
    throw new Error(`Bundle share path escapes the configured share root: ${bundleId}`);
  }

  await mkdir(sharePath, {recursive: true});
  return sharePath;
}
