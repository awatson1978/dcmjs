// packages/cli/test/validate.test.js

import fs from "fs";
import os from "os";
import path from "path";
import dcmjs from "../../../src/index.js";
import { validationLog } from "../../../src/log.js";
import { runValidate } from "../src/commands/validate.mjs";

validationLog.setLevel(5);

const REPO_TEST_DIR = path.join(__dirname, "..", "..", "..", "test");
const FIXTURE = path.join(REPO_TEST_DIR, "sample-dicom.dcm");

function capture() {
    const lines = [];
    return { lines, write: text => lines.push(text) };
}

let tmpDir;
beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dcmjs-cli-validate-"));
    // A clean file and a truncated (unparseable) sibling
    fs.copyFileSync(FIXTURE, path.join(tmpDir, "good.dcm"));
    const bytes = fs.readFileSync(FIXTURE);
    fs.writeFileSync(
        path.join(tmpDir, "truncated.dcm"),
        bytes.subarray(0, 160)
    );
});

afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("validate reports ok and exits 0 for a clean file", async () => {
    const out = capture();
    const err = capture();
    const code = await runValidate({
        dcmjs,
        positionals: [FIXTURE],
        values: {},
        stdout: out.write,
        stderr: err.write
    });
    expect(code).toBe(0);
    const text = out.lines.join("\n");
    expect(text).toMatch(/ok\s+/);
    expect(text).toMatch(/1\/1 clean/);
});

test("validate discovers directories and exits 1 on failures", async () => {
    const out = capture();
    const err = capture();
    const code = await runValidate({
        dcmjs,
        positionals: [tmpDir],
        values: {},
        stdout: out.write,
        stderr: err.write
    });
    expect(code).toBe(1);
    const text = out.lines.join("\n");
    expect(text).toMatch(/FAIL/);
    expect(text).toMatch(/1\/2 clean, 1 failed/);
});

test("validate --json writes a machine-readable report", async () => {
    const out = capture();
    const err = capture();
    const reportPath = path.join(tmpDir, "report.json");
    const code = await runValidate({
        dcmjs,
        positionals: [tmpDir],
        values: { quiet: true, json: reportPath },
        stdout: out.write,
        stderr: err.write
    });
    expect(code).toBe(1);
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    const statuses = report.map(record => record.status).sort();
    expect(statuses).toEqual(["fail", "ok"]);
});

test("validate errors when given no inputs", async () => {
    const out = capture();
    const err = capture();
    const code = await runValidate({
        dcmjs,
        positionals: [],
        values: {},
        stdout: out.write,
        stderr: err.write
    });
    expect(code).toBe(1);
    expect(err.lines.join("\n")).toMatch(/no input/i);
});
