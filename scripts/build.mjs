import { build, context } from "esbuild";

const watch = process.argv.includes("--watch");

const builds = [
  {
    entryPoints: ["src/extension.ts"],
    outfile: "dist/extension.js",
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node20",
    external: ["vscode"],
    sourcemap: true,
    logLevel: "info",
  },
  {
    entryPoints: ["src/webview/main.ts"],
    outfile: "dist/webview.js",
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    sourcemap: true,
    logLevel: "info",
  },
];

if (watch) {
  const contexts = await Promise.all(builds.map((options) => context(options)));
  await Promise.all(contexts.map((ctx) => ctx.watch()));
  console.log("Watching VS Code host and webview bundles...");
} else {
  await Promise.all(builds.map((options) => build(options)));
}
