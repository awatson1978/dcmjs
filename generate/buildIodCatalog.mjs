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

/**
 * types/dcmjs-iods.d.ts — per-CIOD dataset interfaces (Workstream D).
 *
 * Every CIOD becomes `<PascalCasedId>Dataset extends NaturalizedDataset`
 * with (a) SOPClassUID narrowed to the UID literal(s) that resolve to the
 * CIOD and (b) the TOP-LEVEL Type 1/2 attributes of its usage:"M" modules
 * made required — Type 1 additionally NonNullable. Everything else stays
 * inherited-optional. Wildcard rows (repeating groups), nested rows, and
 * conditional/optional modules are not narrowed (runtime layer-3
 * validation covers them; asIod is the runtime counterpart).
 *
 * @param {Object} catalog buildIodCatalog output
 * @param {Object} attributes naturalizedRules.attributes (tag -> {keyword})
 *        — the same generated catalog dcmjs-schema.d.ts is built from, so
 *        every keyword resolves to a NaturalizedDataset key
 */
export function iodTypesSource(catalog, attributes) {
    const pascal = id => {
        const name = id
            .split("-")
            .map(part => part.charAt(0).toUpperCase() + part.slice(1))
            .join("");
        // Identifiers cannot start with a digit ("12-lead-ecg").
        return /^\d/.test(name) ? `_${name}` : name;
    };

    const interfaceNames = new Map(); // ciodId -> interface name
    for (const ciodId of Object.keys(catalog.ciods)) {
        const name = `${pascal(ciodId)}Dataset`;
        for (const [otherId, otherName] of interfaceNames) {
            if (otherName === name) {
                throw new Error(
                    `interface name collision: ${ciodId} / ${otherId}`
                );
            }
        }
        interfaceNames.set(ciodId, name);
    }

    const uidsByCiod = new Map();
    for (const [uid, ciodId] of Object.entries(catalog.sops)) {
        const list = uidsByCiod.get(ciodId) || [];
        list.push(uid);
        uidsByCiod.set(ciodId, list);
    }

    const lines = [
        "// GENERATED by generate/generate-iods.mjs — DO NOT EDIT.",
        "// Rebuild: node generate/generate-iods.mjs (data: node scripts/refresh-dicom-standard.mjs)",
        "// Source: innolitics/dicom-standard (MIT) — see generate/data/dicom-standard/VERSION.md.",
        `// IOD catalog ${catalog.version} (edition ${catalog.sourceEdition}, hash ${catalog.sourceHash}).`,
        "//",
        "// Typed IOD datasets: one interface per CIOD, narrowing the top-level",
        "// Type 1/2 attributes of its mandatory (usage M) modules to required",
        "// keys (Type 1 additionally NonNullable) and SOPClassUID to the UID",
        "// literal(s). Conditional/optional modules, nested paths and",
        "// repeating groups stay inherited-optional — asIod() is the runtime",
        "// counterpart (validate layers 1+3).",
        "",
        'import { NaturalizedDataset } from "./dcmjs-schema";',
        ""
    ];

    for (const [ciodId, ciod] of Object.entries(catalog.ciods)) {
        const required = new Map(); // keyword -> {type, modules: []}
        for (const moduleRef of ciod.modules) {
            if (moduleRef.usage !== "M" || moduleRef.id.startsWith("fg:")) {
                continue;
            }
            for (const [path, type] of catalog.modules[moduleRef.id]) {
                if (
                    (type !== "1" && type !== "2") ||
                    path.includes(".") ||
                    path.includes("X")
                ) {
                    continue;
                }
                const attribute = attributes[path];
                if (!attribute || attribute.keyword === "SOPClassUID") {
                    continue; // unnamed tag / narrowed separately
                }
                const entry = required.get(attribute.keyword) || {
                    type,
                    modules: []
                };
                if (type === "1") {
                    entry.type = "1"; // strongest wins
                }
                if (!entry.modules.includes(moduleRef.id)) {
                    entry.modules.push(moduleRef.id);
                }
                required.set(attribute.keyword, entry);
            }
        }

        const uids = uidsByCiod.get(ciodId) || [];
        lines.push(`/** ${ciod.name} (CIOD "${ciodId}") */`);
        lines.push(
            `export interface ${interfaceNames.get(
                ciodId
            )} extends NaturalizedDataset {`
        );
        if (uids.length) {
            lines.push(
                "    /** SOP Class UID — narrowed to the storage UID literal(s) of this CIOD. */"
            );
            lines.push(
                `    SOPClassUID: ${uids
                    .map(uid => JSON.stringify(uid))
                    .join(" | ")};`
            );
        }
        // Group the narrowed keys by their (first) owning module, modules in
        // catalog order, rows in packed (tag) order.
        const emitted = new Set();
        for (const moduleRef of ciod.modules) {
            const keys = [...required.entries()].filter(
                ([keyword, entry]) =>
                    entry.modules[0] === moduleRef.id && !emitted.has(keyword)
            );
            if (!keys.length) {
                continue;
            }
            lines.push(`    // ${moduleRef.id} (M)`);
            for (const [keyword, entry] of keys) {
                emitted.add(keyword);
                lines.push(
                    `    /** Type ${entry.type} · ${entry.modules
                        .map(id => `${id} (M)`)
                        .join(", ")} */`
                );
                lines.push(
                    entry.type === "1"
                        ? `    ${keyword}: NonNullable<NaturalizedDataset["${keyword}"]>;`
                        : `    ${keyword}: NaturalizedDataset["${keyword}"];`
                );
            }
        }
        lines.push("}");
        lines.push("");
    }

    lines.push("/** SOP Class UID literal -> typed dataset interface. */");
    lines.push("export interface SopClassDatasetMap {");
    for (const [uid, ciodId] of Object.entries(catalog.sops)) {
        lines.push(`    /** ${catalog.ciods[ciodId].name} */`);
        lines.push(
            `    ${JSON.stringify(uid)}: ${interfaceNames.get(ciodId)};`
        );
    }
    lines.push("}");
    lines.push("");
    lines.push("export type SopClassUid = keyof SopClassDatasetMap;");
    lines.push("");
    lines.push(
        '/** Dataset type for a SOP Class UID literal: DicomDataset<"1.2.840.10008.5.1.4.1.1.2">. */'
    );
    lines.push(
        "export type DicomDataset<T extends SopClassUid> = SopClassDatasetMap[T];"
    );
    lines.push("");
    lines.push(
        "/** One validate()/asIod issue (see src/validation/result.js). */"
    );
    lines.push("export interface ValidationIssue {");
    lines.push('    severity: "error" | "warning" | "info";');
    lines.push("    rule: string;");
    lines.push("    message: string;");
    lines.push("    tag?: string;");
    lines.push("    keyword?: string;");
    lines.push("    path?: string;");
    lines.push("    module?: string;");
    lines.push("}");
    lines.push("");
    lines.push("/** Thrown by asIod() on ERROR-severity issues. */");
    lines.push("export declare class IodValidationError extends Error {");
    lines.push("    issues: ValidationIssue[];");
    lines.push("}");
    lines.push("");
    lines.push(
        "/** Runtime narrowing: validate (layers 1+3) and return the typed dataset, or throw. */"
    );
    lines.push("export declare function asIod<T extends SopClassUid>(");
    lines.push("    dataset: unknown,");
    lines.push("    sopClassUid?: T,");
    lines.push(
        "    options?: { lenient?: boolean; ignore?: string[]; maxIssues?: number }"
    );
    lines.push("): Promise<DicomDataset<T>>;");
    lines.push("");
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
