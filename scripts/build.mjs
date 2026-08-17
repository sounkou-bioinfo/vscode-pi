import { rmSync } from "node:fs";
import { build, context } from "esbuild";

const watch = process.argv.includes("--watch");
rmSync("dist", { recursive: true, force: true });
const options = {
  entryPoints: {
    extension: "src/extension.ts",
    dictationHelper: "src/dictationHelper.ts",
  },
  outdir: "dist",
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node22",
  external: ["vscode", "@picovoice/pvrecorder-node", "transcribe-cpp"],
  sourcemap: true,
  logLevel: "info",
};

if (watch) {
  const buildContext = await context(options);
  await buildContext.watch();
  console.log("Watching Pi TUI companion bundle...");
} else {
  await build(options);
}
