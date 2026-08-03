// packages/cli/test/cli.test.js — router + argv parsing

import path from "path";
import dcmjs from "../../../src/index.js";
import { validationLog } from "../../../src/log.js";
import { runCli } from "../src/cli.mjs";

validationLog.setLevel(5);

const FIXTURE = path.join(
    __dirname,
    "..",
    "..",
    "..",
    "test",
    "sample-dicom.dcm"
);

function capture() {
    const lines = [];
    return { lines, write: text => lines.push(text) };
}

async function cli(argv) {
    const out = capture();
    const err = capture();
    const code = await runCli({
        dcmjs,
        argv,
        stdout: out.write,
        stderr: err.write
    });
    return { code, out: out.lines.join("\n"), err: err.lines.join("\n") };
}

test("--help prints usage and exits 0", async () => {
    const { code, out } = await cli(["--help"]);
    expect(code).toBe(0);
    expect(out).toMatch(/convert/);
    expect(out).toMatch(/dump/);
    expect(out).toMatch(/anonymize/);
    expect(out).toMatch(/validate/);
});

test("no arguments prints usage and exits 1", async () => {
    const { code, err } = await cli([]);
    expect(code).toBe(1);
    expect(err).toMatch(/usage/i);
});

test("unknown command exits 1", async () => {
    const { code, err } = await cli(["frobnicate"]);
    expect(code).toBe(1);
    expect(err).toMatch(/unknown command/i);
});

test("unknown option exits 1 with the parseArgs message", async () => {
    const { code, err } = await cli(["dump", FIXTURE, "--bogus"]);
    expect(code).toBe(1);
    expect(err).toMatch(/bogus/);
});

test("full argv path: convert --to json", async () => {
    const { code, out } = await cli(["convert", FIXTURE, "--to", "json"]);
    expect(code).toBe(0);
    expect(JSON.parse(out).Modality).toBe("MR");
});
