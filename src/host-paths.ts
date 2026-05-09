import {isAbsolute, resolve} from "node:path";
import {resolveHomeDirectory} from "./home-directory.js";

function expandHomePath(inputPath: string, env: NodeJS.ProcessEnv = process.env): string {
  if (inputPath === "~") {
    return resolveHomeDirectory(env);
  }
  if (inputPath.startsWith("~/")) {
    return resolve(resolveHomeDirectory(env), inputPath.slice(2));
  }
  return inputPath;
}

export function resolveAbsoluteHostPath(
  inputPath: string,
  fieldName: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const expandedPath = expandHomePath(inputPath, env);
  if (!isAbsolute(expandedPath)) {
    throw new Error(`${fieldName} must be an absolute path.`);
  }
  return resolve(expandedPath);
}
