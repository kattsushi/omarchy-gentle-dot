import { chmodSync, lstatSync, mkdirSync } from "node:fs";

// A folder of ours, created 0700 and checked to be our own real folder (not a link) before use.
export function privateDir(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stats = lstatSync(path);
  if (!stats.isDirectory() || stats.uid !== process.getuid()) throw new Error(`not a private folder: ${path}`);
  if ((stats.mode & 0o077) !== 0) chmodSync(path, 0o700);
  return path;
}
