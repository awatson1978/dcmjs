// IOD catalog builder — pure (no I/O, no import.meta), so the CI gates can
// import it under jest. The CLI shell that writes files is generate-iods.mjs.
// Mirrors the buildCatalog.mjs / generate-schema.mjs pattern (Workstream A).
//
// Input: the stripped innolitics/dicom-standard snapshots from
// generate/data/dicom-standard/ (see VERSION.md there), parsed and passed in
// as one object. Output: the catalog behind the three committed artifacts —
//   src/schema/iodIndex.js        (eager, small: SOP -> CIOD -> modules)
//   src/schema/iodModules.packed.js (lazy: per-module attribute tables)
//   schema/iod.schema.json        (JSON-Schema projection of the index)
import { createHash } from "crypto";
import {
    assertUsage,
    normalizePath,
    normalizeType,
    FG_SHARED,
    FG_PER_FRAME
} from "./iodRules.mjs";

const IOD_CATALOG_VERSION = "1.0.0";

// vendored = { meta, ciods, sops, modules, macros, ciodToModules,
//              ciodToFuncGroupMacros, moduleToAttributes, macroToAttributes }
export function buildIodCatalog(vendored) {
    const sourceHash = createHash("sha256")
        .update(
            JSON.stringify([
                vendored.meta,
                vendored.ciods,
                vendored.sops,
                vendored.modules,
                vendored.macros,
                vendored.ciodToModules,
                vendored.ciodToFuncGroupMacros,
                vendored.moduleToAttributes,
                vendored.macroToAttributes
            ])
        )
        .digest("hex")
        .slice(0, 16);

    const ciodNameToId = new Map(vendored.ciods.map(c => [c.name, c.id]));
    const ciodIds = new Set(vendored.ciods.map(c => c.id));
    const moduleNames = new Map(vendored.modules.map(m => [m.id, m.name]));
    const macroNames = new Map(vendored.macros.map(m => [m.id, m.name]));

    // --- packed attribute tables -------------------------------------------
    const counters = { none: 0 };
    const conditionSet = new Set();
    const collectConditions = (table, key) => {
        for (const rows of Object.values(table[key])) {
            for (const row of rows) {
                if (row.length > 2) {
                    conditionSet.add(table.conditions[row[2]]);
                }
            }
        }
    };
    collectConditions(vendored.moduleToAttributes, "modules");
    collectConditions(vendored.macroToAttributes, "macros");
    const conditions = [...conditionSet].sort();
    const conditionIndex = new Map(conditions.map((c, i) => [c, i]));

    const packRows = (ownerId, snapshotRows, table, prefix) => {
        const out = [];
        for (const [relPath, rawType, cIdx] of snapshotRows) {
            const path = normalizePath(`${ownerId}:${relPath}`, ownerId);
            const type = normalizeType(rawType, counters);
            const row = [prefix ? `${prefix}.${path}` : path, type];
            if (cIdx !== undefined) {
                row.push(conditionIndex.get(table.conditions[cIdx]));
            }
            out.push(row);
        }
        out.sort((a, b) =>
            a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1
        );
        return out;
    };

    const modules = {};
    for (const moduleId of Object.keys(
        vendored.moduleToAttributes.modules
    ).sort()) {
        if (!moduleNames.has(moduleId)) {
            throw new Error(`attribute table for unknown module ${moduleId}`);
        }
        modules[moduleId] = packRows(
            moduleId,
            vendored.moduleToAttributes.modules[moduleId],
            vendored.moduleToAttributes
        );
    }

    // Functional-group macros become synthetic modules ("fg:<macro-id>")
    // whose rows live under both SharedFunctionalGroupsSequence and
    // PerFrameFunctionalGroupsSequence — whether a given group is shared or
    // per-frame is an instance-level choice, so the catalog carries both.
    const fgMacroIds = [
        ...new Set(vendored.ciodToFuncGroupMacros.map(r => r.macroId))
    ].sort();
    for (const macroId of fgMacroIds) {
        const snapshotRows = vendored.macroToAttributes.macros[macroId];
        if (!snapshotRows || !macroNames.has(macroId)) {
            throw new Error(`functional-group macro ${macroId} has no table`);
        }
        const table = vendored.macroToAttributes;
        modules[`fg:${macroId}`] = [
            ...packRows(macroId, snapshotRows, table, FG_SHARED),
            ...packRows(macroId, snapshotRows, table, FG_PER_FRAME)
        ];
    }

    // --- index: SOP -> CIOD -> module list ---------------------------------
    const ciodModules = new Map(); // ciodId -> [{id, ie, usage, condition?}]
    for (const row of vendored.ciodToModules) {
        if (!ciodIds.has(row.ciodId)) {
            throw new Error(`ciod_to_modules references unknown ${row.ciodId}`);
        }
        if (!modules[row.moduleId]) {
            throw new Error(
                `${row.ciodId} references module ${row.moduleId} with no table`
            );
        }
        const entry = {
            id: row.moduleId,
            ie: row.informationEntity,
            usage: assertUsage(row.usage, `${row.ciodId}/${row.moduleId}`)
        };
        if (row.condition) {
            entry.condition = row.condition;
        }
        const list = ciodModules.get(row.ciodId) || [];
        list.push(entry);
        ciodModules.set(row.ciodId, list);
    }
    for (const row of vendored.ciodToFuncGroupMacros) {
        if (!ciodIds.has(row.ciodId)) {
            throw new Error(
                `ciod_to_func_group_macros references unknown ${row.ciodId}`
            );
        }
        const entry = {
            id: `fg:${row.macroId}`,
            ie: "Functional Groups",
            usage: assertUsage(row.usage, `${row.ciodId}/fg:${row.macroId}`)
        };
        if (row.condition) {
            entry.condition = row.condition;
        }
        ciodModules.get(row.ciodId).push(entry);
    }

    const ciods = {};
    for (const c of [...vendored.ciods].sort((a, b) =>
        a.id < b.id ? -1 : 1
    )) {
        const list = ciodModules.get(c.id) || [];
        list.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        ciods[c.id] = { name: c.name, modules: list };
    }

    const sops = {};
    for (const s of [...vendored.sops].sort((a, b) => (a.id < b.id ? -1 : 1))) {
        const ciodId = ciodNameToId.get(s.ciod);
        if (!ciodId) {
            throw new Error(`SOP ${s.id} references unknown CIOD "${s.ciod}"`);
        }
        sops[s.id] = ciodId;
    }

    return {
        version: IOD_CATALOG_VERSION,
        sourceEdition: vendored.meta.edition,
        sourceHash,
        sops,
        ciods,
        conditions,
        modules,
        noneTypeCount: counters.none
    };
}

const GENERATED_HEADER =
    "// GENERATED by generate/generate-iods.mjs — DO NOT EDIT.\n" +
    "// Rebuild: node generate/generate-iods.mjs (data: node scripts/refresh-dicom-standard.mjs)\n" +
    "// Source: innolitics/dicom-standard (MIT) — see generate/data/dicom-standard/VERSION.md.\n";

export function iodIndexSource(catalog) {
    const index = {
        version: catalog.version,
        sourceEdition: catalog.sourceEdition,
        sourceHash: catalog.sourceHash,
        sops: catalog.sops,
        ciods: catalog.ciods
    };
    return (
        GENERATED_HEADER +
        "// Part 3 IOD index — eager and small. SOP Class UID -> CIOD -> module\n" +
        "// list with usage (M/C/U) + condition text. The per-module attribute\n" +
        "// tables live in iodModules.packed.js (lazy).\n" +
        `export const iodIndex = ${JSON.stringify(index, null, 2)};\n` +
        "\n" +
        "export function getIodForSopClass(sopClassUid) {\n" +
        "    const ciodId = iodIndex.sops[sopClassUid];\n" +
        "    if (!ciodId) {\n" +
        "        return null;\n" +
        "    }\n" +
        "    return { sopClassUid, ciodId, ...iodIndex.ciods[ciodId] };\n" +
        "}\n"
    );
}

export function iodModulesPackedSource(catalog) {
    const lines = [
        GENERATED_HEADER +
            "// Part 3 per-module attribute tables, packed as minified-JSON strings\n" +
            "// and lazily parsed + memoized on first use — zero work at import.\n" +
            "// Rows [path, type, conditionIndex?] hydrate to {path, type, condition?}\n" +
            "// with bare-hex dot paths ('00400275.00081080') and Type 1/1C/2/2C/3.\n" +
            "// 'fg:<macro-id>' entries are functional-group macros expanded under\n" +
            "// the Shared/PerFrame FunctionalGroupsSequence paths.\n",
        "// Deduplicated condition sentences (reporting-only; see VERSION.md).",
        `export const CONDITIONS = ${JSON.stringify(catalog.conditions, null, 2)};`,
        "",
        "const PACKED = {"
    ];
    const moduleIds = Object.keys(catalog.modules);
    moduleIds.forEach((moduleId, i) => {
        const json = JSON.stringify(catalog.modules[moduleId]);
        if (json.includes("'") || json.includes("\\")) {
            throw new Error(`packed rows for ${moduleId} need escaping`);
        }
        const comma = i < moduleIds.length - 1 ? "," : "";
        lines.push(`    ${JSON.stringify(moduleId)}: '${json}'${comma}`);
    });
    lines.push(
        "};",
        "",
        "const cache = new Map();",
        "",
        "export function getModuleAttributes(moduleId) {",
        "    const cached = cache.get(moduleId);",
        "    if (cached) {",
        "        return cached;",
        "    }",
        "    const packed = PACKED[moduleId];",
        "    if (!packed) {",
        "        return null;",
        "    }",
        "    const rows = JSON.parse(packed).map(([path, type, c]) => {",
        "        const row = { path, type };",
        "        if (c !== undefined) {",
        "            row.condition = CONDITIONS[c];",
        "        }",
        "        return row;",
        "    });",
        "    cache.set(moduleId, rows);",
        "    return rows;",
        "}",
        ""
    );
    return lines.join("\n");
}

export function iodJsonSchemaSource(catalog) {
    const doc = {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $id: "https://dcmjs.org/schema/iod.schema.json",
        title: "dcmjs IOD index",
        description:
            "Projection of the Part 3 IOD index (src/schema/iodIndex.js): " +
            "SOP Class UID -> CIOD -> modules with usage and condition text. " +
            "Conditions are reporting-only text; 1C/2C never error.",
        "x-dicom-iod-catalog-version": catalog.version,
        "x-dicom-source-edition": catalog.sourceEdition,
        "x-dicom-source-hash": catalog.sourceHash,
        type: "object",
        properties: {
            version: { type: "string" },
            sourceEdition: { type: "string" },
            sourceHash: { type: "string", pattern: "^[0-9a-f]{16}$" },
            sops: {
                type: "object",
                description: "SOP Class UID -> CIOD id",
                patternProperties: {
                    "^[0-9.]+$": { type: "string" }
                },
                additionalProperties: false
            },
            ciods: {
                type: "object",
                additionalProperties: { $ref: "#/$defs/ciod" }
            }
        },
        required: ["version", "sourceEdition", "sourceHash", "sops", "ciods"],
        additionalProperties: false,
        $defs: {
            ciod: {
                type: "object",
                properties: {
                    name: { type: "string" },
                    modules: {
                        type: "array",
                        items: { $ref: "#/$defs/moduleRef" }
                    }
                },
                required: ["name", "modules"],
                additionalProperties: false
            },
            moduleRef: {
                type: "object",
                properties: {
                    id: { type: "string" },
                    ie: { type: "string" },
                    usage: { enum: ["M", "C", "U"] },
                    condition: { type: "string" }
                },
                required: ["id", "ie", "usage"],
                additionalProperties: false
            }
        }
    };
    return JSON.stringify(doc, null, 2) + "\n";
}
