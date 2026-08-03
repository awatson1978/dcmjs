#!/usr/bin/env node
// packages/cli/bin/dcmjs.mjs
//
// Entry point: loads the BUILT dcmjs bundle (build/dcmjs.js) via
// createRequire — src/ is untranspiled ESM the runtime can't load directly
// (same approach as scripts/corpus-runner.mjs) — and hands it to the
// router. Tests bypass this file and inject src/index.js.

import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { runCli } from "../src/cli.mjs";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    ".."
);
const bundlePath = path.join(repoRoot, "build", "dcmjs.js");

let dcmjs;
try {
    dcmjs = require(bundlePath);
} catch {
    console.error(
        `dcmjs CLI needs the built bundle (${bundlePath}).\n` +
            "Run `pnpm run build` in the dcmjs repo first."
    );
    process.exit(1);
}

// Parser chatter would drown command output (corpus-runner precedent)
dcmjs.log.setLevel("silent");
dcmjs.log.getLogger("validation.dcmjs").setLevel("silent");

runCli({
    dcmjs,
    argv: process.argv.slice(2),
    stdout: text => process.stdout.write(text + "\n"),
    stderr: text => process.stderr.write(text + "\n")
}).then(
    code => process.exit(code),
    err => {
        console.error(`dcmjs: ${err.message}`);
        process.exit(1);
    }
);
