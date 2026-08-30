// Refreshes the stripped innolitics/dicom-standard snapshots under
// generate/data/dicom-standard/ from the PINNED upstream commit.
// Usage: node scripts/refresh-dicom-standard.mjs
//
// The raw upstream tables total ~93 MB (module_to_attributes.json alone is
// 78 MB — HTML descriptions dominate). This script keeps only the fields the
// IOD catalog needs and reduces every description to its extracted condition
// sentence, producing deterministic snapshots small enough to commit
// (stable key order, sorted rows, one row per line for reviewable diffs).
// To move to a new upstream commit: bump COMMIT (and EDITION if upstream
// regenerated against a newer DICOM edition), rerun, then run
// `node generate/generate-iods.mjs` and the schema gates.
import { mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { extractConditionText } from "../generate/iodRules.mjs";

// Pinned upstream (MIT — see NOTICE and generate/data/dicom-standard/VERSION.md).
const REPOSITORY = "https://github.com/innolitics/dicom-standard";
const COMMIT = "90571bcc4e46b08bc815bd683e6c466308bcff9a";
// DICOM edition the pinned data was parsed from (upstream's monthly
// auto-refresh was disabled after its 2024e regeneration).
const EDITION = "2024e";
const BASE = `https://raw.githubusercontent.com/innolitics/dicom-standard/${COMMIT}/standard/`;

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "generate", "data", "dicom-standard");

async function fetchJson(name) {
    const url = `${BASE}${name}`;
    const res = await fetch(url);
    if (!res.ok) {
        throw new Error(`GET ${url} -> ${res.status}`);
    }
    return res.json();
}

function byId(a, b) {
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function writeJson(name, value) {
    writeFileSync(join(outDir, name), JSON.stringify(value, null, 1) + "\n");
    console.log(`wrote ${name}`);
}

// { conditions: [...deduped strings...], <groupKey>: { id: [rows...] } }
// with one minified row per line so diffs stay reviewable.
function writeAttributeTable(name, groupKey, groups, conditions) {
    const lines = ['{\n "conditions": ['];
    lines.push(conditions.map(c => `  ${JSON.stringify(c)}`).join(",\n"));
    lines.push(` ],\n "${groupKey}": {`);
    const ids = Object.keys(groups).sort();
    lines.push(
        ids
            .map(id => {
                const rows = groups[id]
                    .map(row => `   ${JSON.stringify(row)}`)
                    .join(",\n");
                return `  ${JSON.stringify(id)}: [\n${rows}\n  ]`;
            })
            .join(",\n")
    );
    lines.push(" }\n}\n");
    writeFileSync(join(outDir, name), lines.join("\n"));
    console.log(`wrote ${name}`);
}

// Strip an upstream *_to_attributes table: keep path (verbatim colon form,
// grouped by owner id so the prefix is not repeated), type (verbatim,
// including upstream's "None"), and the extracted condition sentence as an
// index into a per-file deduplicated conditions array.
function stripAttributes(rawRows, ownerField) {
    const conditionSet = new Set();
    for (const row of rawRows) {
        const condition = extractConditionText(row.description);
        if (condition) {
            conditionSet.add(condition);
        }
    }
    const conditions = [...conditionSet].sort();
    const conditionIndex = new Map(conditions.map((c, i) => [c, i]));
    const groups = {};
    for (const row of rawRows) {
        const owner = row[ownerField];
        const prefix = `${owner}:`;
        if (!row.path.startsWith(prefix)) {
            throw new Error(
                `${row.path}: path does not start with ${ownerField} "${owner}"`
            );
        }
        const relPath = row.path.slice(prefix.length);
        const condition = extractConditionText(row.description);
        const packed = condition
            ? [relPath, row.type, conditionIndex.get(condition)]
            : [relPath, row.type];
        (groups[owner] = groups[owner] || []).push(packed);
    }
    for (const owner of Object.keys(groups)) {
        groups[owner].sort((a, b) =>
            a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1
        );
    }
    return { conditions, groups };
}

function stripJoin(rawRows, keys) {
    return rawRows
        .map(row => {
            const out = {};
            for (const key of keys) {
                out[key] = row[key];
            }
            if (row.conditionalStatement) {
                out.condition = row.conditionalStatement
                    .replace(/\s+/g, " ")
                    .trim();
            }
            return out;
        })
        .sort((a, b) => {
            const ka = keys.map(k => a[k]).join("|");
            const kb = keys.map(k => b[k]).join("|");
            return ka < kb ? -1 : ka > kb ? 1 : 0;
        });
}

try {
    mkdirSync(outDir, { recursive: true });

    console.log(`fetching ${REPOSITORY} @ ${COMMIT} ...`);
    const [ciods, sops, modules, macros] = await Promise.all([
        fetchJson("ciods.json"),
        fetchJson("sops.json"),
        fetchJson("modules.json"),
        fetchJson("macros.json")
    ]);
    const [ciodToModules, ciodToFgMacros, confidentiality] = await Promise.all([
        fetchJson("ciod_to_modules.json"),
        fetchJson("ciod_to_func_group_macros.json"),
        fetchJson("confidentiality_profile_attributes.json")
    ]);
    // The big ones — fetched serially to keep peak memory sane.
    const macroToAttributes = await fetchJson("macro_to_attributes.json");
    const moduleToAttributes = await fetchJson("module_to_attributes.json");

    writeJson("meta.json", {
        repository: REPOSITORY,
        commit: COMMIT,
        edition: EDITION
    });
    writeJson(
        "ciods.json",
        ciods.map(c => ({ id: c.id, name: c.name })).sort(byId)
    );
    writeJson(
        "sops.json",
        sops.map(s => ({ id: s.id, name: s.name, ciod: s.ciod })).sort(byId)
    );
    writeJson(
        "modules.json",
        modules.map(m => ({ id: m.id, name: m.name })).sort(byId)
    );
    writeJson(
        "macros.json",
        macros.map(m => ({ id: m.id, name: m.name })).sort(byId)
    );
    writeJson(
        "ciod_to_modules.json",
        stripJoin(ciodToModules, [
            "ciodId",
            "moduleId",
            "informationEntity",
            "usage"
        ])
    );
    writeJson(
        "ciod_to_func_group_macros.json",
        stripJoin(ciodToFgMacros, ["ciodId", "macroId", "moduleType", "usage"])
    );
    // Vendored now for the tranche-3 PS3.15 de-identification work — the
    // rows are already lean; keep them whole, sorted by tag id.
    writeJson("confidentiality_profile_attributes.json", [...confidentiality].sort(byId));

    const m2a = stripAttributes(moduleToAttributes, "moduleId");
    writeAttributeTable(
        "module_to_attributes.json",
        "modules",
        m2a.groups,
        m2a.conditions
    );
    const mac2a = stripAttributes(macroToAttributes, "macroId");
    writeAttributeTable(
        "macro_to_attributes.json",
        "macros",
        mac2a.groups,
        mac2a.conditions
    );

    console.log("done — now run: node generate/generate-iods.mjs");
} catch (err) {
    console.error(`refresh-dicom-standard FAILED: ${err.message}`);
    process.exit(1);
}
