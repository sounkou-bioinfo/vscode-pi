import { spawnSync } from "node:child_process";

const supportedTargets = new Set([
  "win32-x64",
  "darwin-x64",
  "darwin-arm64",
  "linux-x64",
  "linux-arm64",
]);
const target = process.env.VSCODE_PI_TARGET || `${process.platform}-${process.arch}`;
if (!supportedTargets.has(target)) {
  console.error(`Cannot package Pi dictation for unsupported desktop target ${target}`);
  process.exit(1);
}

const executable = process.platform === "win32" ? "vsce.cmd" : "vsce";
const result = spawnSync(
  executable,
  ["package", "--target", target, "--out", "vscode-pi.vsix"],
  { stdio: "inherit" },
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
