import { readFile, writeFile } from "node:fs/promises";

const source = await readFile(new URL("../README.Rmd", import.meta.url), "utf8");
const target = new URL("../README.md", import.meta.url);

if (process.argv.includes("--check")) {
	const current = await readFile(target, "utf8").catch(() => "");
	if (current !== source) {
		console.error("README.md is stale; run npm run render:readme");
		process.exitCode = 1;
	} else {
		console.log("README.md is current");
	}
} else {
	await writeFile(target, source, "utf8");
	console.log("wrote README.md");
}
