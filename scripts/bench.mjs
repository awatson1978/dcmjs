// scripts/bench.mjs
//
// The benchmark matrix: contenders × workloads × corpus, one fresh process
// per cell (scripts/bench-worker.mjs) so peak RSS is attributable and no
// contender warms another's caches. Prints a markdown table (the source of
// BENCHMARKS.md) and optionally JSON.
//
//   pnpm run build                # the fork is measured via its built bundle
//   node scripts/bench.mjs                     # committed-fixture corpus
//   node scripts/bench.mjs --large <file.dcm>  # add a large-file stream row
//   node scripts/bench.mjs --json out.json
//
// Contenders: this fork's bundle, `dcmjs-upstream` (npm latest), and
// dicom-parser (parse-only reference). Every cell reports median ms over N
// iterations (after warmup) and the process's peak RSS.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const workerPath = path.join(repoRoot, "scripts", "bench-worker.mjs");

const CORPUS = [
    {
        name: "sample-dicom.dcm (528 KB CT image)",
        file: "test/sample-dicom.dcm",
        iterations: 40
    },
    {
        name: "cine-test.dcm (1.0 MB multiframe)",
        file: "test/cine-test.dcm",
        iterations: 30
    },
    {
        name: "sample-op.dcm (103 KB encapsulated)",
        file: "test/sample-op.dcm",
        iterations: 40
    },
    {
        name: "sample-sr.dcm (4.5 KB SR)",
        file: "test/sample-sr.dcm",
        iterations: 100
    }
];

const WORKLOADS = ["read", "read+naturalize", "write", "roundtrip"];
const CONTENDERS = ["fork", "upstream", "dicom-parser"];

function runCell(spec) {
    const out = execFileSync(
        process.execPath,
        [workerPath, JSON.stringify(spec)],
        { encoding: "utf8", timeout: 30 * 60 * 1000 }
    );
    const lastLine = out.trim().split("\n").pop();
    return JSON.parse(lastLine);
}

function fmt(result) {
    if (!result) {
        return "—";
    }
    if (result.error) {
        return `FAILS (${result.error.slice(0, 60)})`;
    }
    const ms =
        result.medianMs >= 100
            ? Math.round(result.medianMs).toLocaleString("en-US")
            : result.medianMs.toFixed(1);
    return `${ms} ms · ${result.maxRssMb} MB`;
}

const args = process.argv.slice(2);
const largeFiles = [];
for (let i = 0; i < args.length; i++) {
    if (args[i] === "--large" && args[i + 1]) {
        largeFiles.push(args[++i]);
    }
}
const jsonOut = args.includes("--json")
    ? args[args.indexOf("--json") + 1]
    : null;

const results = [];
const lines = [];
lines.push(
    "| Fixture | Workload | this fork | upstream (npm) | dicom-parser |"
);
lines.push("|---|---|---|---|---|");

for (const fixture of CORPUS) {
    const filePath = path.join(repoRoot, fixture.file);
    if (!fs.existsSync(filePath)) {
        console.error(`skip (missing): ${fixture.file}`);
        continue;
    }
    for (const workload of WORKLOADS) {
        const row = { fixture: fixture.name, workload, cells: {} };
        for (const contender of CONTENDERS) {
            if (contender === "dicom-parser" && workload !== "read") {
                row.cells[contender] = null; // n/a — parse-only library
                continue;
            }
            process.stderr.write(
                `bench: ${fixture.file} ${workload} ${contender}\n`
            );
            row.cells[contender] = runCell({
                contender,
                workload,
                file: filePath,
                iterations: fixture.iterations,
                warmup: 3
            });
        }
        results.push(row);
        lines.push(
            `| ${fixture.name} | ${workload} | ${fmt(row.cells.fork)} | ` +
                `${fmt(row.cells.upstream)} | ${fmt(
                    row.cells["dicom-parser"]
                )} |`
        );
    }
}

for (const large of largeFiles) {
    const stat = fs.statSync(large);
    const gb = (stat.size / 1024 ** 3).toFixed(1);
    const name = `${path.basename(large)} (${gb} GB)`;
    const row = { fixture: name, workload: "stream-walk", cells: {} };
    for (const contender of ["fork", "upstream"]) {
        process.stderr.write(`bench: ${name} stream-walk ${contender}\n`);
        row.cells[contender] = runCell({
            contender,
            workload: "stream-walk",
            file: large,
            iterations: 1,
            warmup: 0
        });
    }
    row.cells["dicom-parser"] = null;
    results.push(row);
    lines.push(
        `| ${name} | full parse (streamed vs whole-file) | ` +
            `${fmt(row.cells.fork)} | ${fmt(row.cells.upstream)} | — |`
    );
}

console.log(lines.join("\n"));
if (jsonOut) {
    fs.writeFileSync(jsonOut, JSON.stringify(results, null, 2) + "\n");
    console.error(`json → ${jsonOut}`);
}
