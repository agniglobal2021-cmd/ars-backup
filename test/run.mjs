// Bundles the tests with the real plugin sources, swapping "obsidian" for a small stub, and runs them in Node.
// Set AGE_BIN to the official age program to also check that it opens the archives.
import esbuild from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const out = join(mkdtempSync(join(tmpdir(), "ars-test-")), "tests.mjs");

await esbuild.build({
	entryPoints: [join(root, "test/index.test.ts")],
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	outfile: out,
	alias: { obsidian: join(root, "test/obsidian-stub.ts") },
	logLevel: "warning",
});

execFileSync(process.execPath, [out], { stdio: "inherit" });
