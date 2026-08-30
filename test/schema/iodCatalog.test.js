// CI determinism + invariant gates for the Part 3 IOD catalog (Workstream A).
// Mirrors the naturalizedRules determinism gate: rebuild the catalog from the
// vendored snapshots and require the committed artifacts to match exactly —
// catches stale artifacts AND nondeterminism.
import { readFileSync } from "fs";
import { join } from "path";
import prettier from "prettier";
import { iodIndex, getIodForSopClass } from "../../src/schema/iodIndex.js";
import {
    CONDITIONS,
    getModuleAttributes
} from "../../src/schema/iodModules.packed.js";
import { naturalizedRules } from "../../src/schema/naturalizedRules.js";
import {
    buildIodCatalog,
    iodIndexSource,
    iodModulesPackedSource,
    iodJsonSchemaSource,
    iodTypesSource
} from "../../generate/buildIodCatalog.mjs";
import {
    ATTRIBUTE_TYPES,
    MODULE_USAGES,
    CONDITIONLESS_1C2C_ROW_COUNT,
    NONE_TYPE_NORMALIZED_ROW_COUNT,
    FG_SHARED,
    FG_PER_FRAME
} from "../../generate/iodRules.mjs";

const root = join(__dirname, "../..");
const dataDir = join(root, "generate", "data", "dicom-standard");

function loadVendoredData() {
    const read = name => JSON.parse(readFileSync(join(dataDir, name), "utf8"));
    return {
        meta: read("meta.json"),
        ciods: read("ciods.json"),
        sops: read("sops.json"),
        modules: read("modules.json"),
        macros: read("macros.json"),
        ciodToModules: read("ciod_to_modules.json"),
        ciodToFuncGroupMacros: read("ciod_to_func_group_macros.json"),
        moduleToAttributes: read("module_to_attributes.json"),
        macroToAttributes: read("macro_to_attributes.json")
    };
}

// Committed src artifacts are prettier-formatted by the generator shell;
// apply the same config before comparing.
function formatted(source, artifactPath) {
    const config = prettier.resolveConfig.sync(artifactPath) || {};
    return prettier.format(source, { ...config, filepath: artifactPath });
}

// String equality asserted as a boolean so a failure reports the artifact,
// not a multi-megabyte diff.
function expectExactArtifact(relPath, regenerated) {
    const committed = readFileSync(join(root, relPath), "utf8");
    if (committed !== regenerated) {
        throw new Error(
            `${relPath} is stale or nondeterministic — run ` +
                "`node generate/generate-iods.mjs` and commit the result"
        );
    }
    expect(committed).toHaveLength(regenerated.length);
}

describe("IOD catalog determinism gates", () => {
    let catalog;
    beforeAll(() => {
        catalog = buildIodCatalog(loadVendoredData());
    });

    test("committed iodIndex.js matches a fresh rebuild", () => {
        const artifact = join(root, "src", "schema", "iodIndex.js");
        expectExactArtifact(
            "src/schema/iodIndex.js",
            formatted(iodIndexSource(catalog), artifact)
        );
    });

    test("committed iodModules.packed.js matches a fresh rebuild", () => {
        const artifact = join(root, "src", "schema", "iodModules.packed.js");
        expectExactArtifact(
            "src/schema/iodModules.packed.js",
            formatted(iodModulesPackedSource(catalog), artifact)
        );
    });

    test("committed iod.schema.json matches a fresh rebuild", () => {
        expectExactArtifact(
            "schema/iod.schema.json",
            iodJsonSchemaSource(catalog)
        );
    });

    test("committed types/dcmjs-iods.d.ts matches a fresh rebuild", () => {
        // Raw source, same convention as types/dcmjs-schema.d.ts (the
        // generator shell writes it unformatted).
        expectExactArtifact(
            "types/dcmjs-iods.d.ts",
            iodTypesSource(catalog, naturalizedRules.attributes)
        );
    });

    test("normalized None-type rows match the audited count", () => {
        expect(catalog.noneTypeCount).toBe(NONE_TYPE_NORMALIZED_ROW_COUNT);
    });
});

describe("IOD index invariants", () => {
    test("carries version, source edition and source hash", () => {
        expect(iodIndex.version).toMatch(/^\d+\.\d+\.\d+$/);
        expect(iodIndex.sourceEdition).toMatch(/^\d{4}[a-z]$/);
        expect(iodIndex.sourceHash).toMatch(/^[0-9a-f]{16}$/);
    });

    test("every SOP Class resolves to a defined CIOD", () => {
        const uids = Object.keys(iodIndex.sops);
        expect(uids.length).toBeGreaterThan(150);
        for (const uid of uids) {
            expect(uid).toMatch(/^[0-9.]+$/);
            expect(iodIndex.ciods[iodIndex.sops[uid]]).toBeDefined();
        }
    });

    test("every referenced module has a packed attribute table", () => {
        for (const [ciodId, ciod] of Object.entries(iodIndex.ciods)) {
            expect(ciod.modules.length).toBeGreaterThan(0);
            for (const m of ciod.modules) {
                const rows = getModuleAttributes(m.id);
                if (!rows) {
                    throw new Error(`${ciodId}: no table for module ${m.id}`);
                }
            }
        }
    });

    test("module usages stay in the closed M/C/U set", () => {
        for (const ciod of Object.values(iodIndex.ciods)) {
            for (const m of ciod.modules) {
                if (!MODULE_USAGES.has(m.usage)) {
                    throw new Error(`${m.id}: usage ${m.usage}`);
                }
            }
        }
    });
});

describe("packed module invariants", () => {
    test("types in the closed set, paths bare-hex, 1C/2C condition coverage", () => {
        // Full sweep over every packed table (hydrates all 549 modules).
        const catalog = buildIodCatalog(loadVendoredData());
        let conditionless = 0;
        for (const [moduleId, rows] of Object.entries(catalog.modules)) {
            for (const [path, type, conditionIdx] of rows) {
                if (!/^[0-9A-FX]{8}(\.[0-9A-FX]{8})*$/.test(path)) {
                    throw new Error(`${moduleId}: bad path ${path}`);
                }
                if (!ATTRIBUTE_TYPES.has(type)) {
                    throw new Error(`${moduleId}: bad type ${type}`);
                }
                if (
                    (type === "1C" || type === "2C") &&
                    conditionIdx === undefined
                ) {
                    conditionless += 1;
                }
            }
        }
        // Reporting-only allowance: conditions live on an enclosing
        // sequence/macro for these rows (see iodRules.mjs).
        expect(conditionless).toBe(CONDITIONLESS_1C2C_ROW_COUNT);
    });

    test("hydration is lazy, memoized and condition-joined", () => {
        expect(getModuleAttributes("no-such-module")).toBeNull();
        const rows = getModuleAttributes("patient");
        expect(rows).toBe(getModuleAttributes("patient")); // memoized
        const conditional = rows.find(r => r.condition);
        expect(CONDITIONS).toContain(conditional.condition);
    });

    test("functional-group macros expand under Shared/PerFrame paths", () => {
        const rows = getModuleAttributes("fg:pixel-measures");
        expect(rows.length).toBeGreaterThan(0);
        for (const row of rows) {
            expect(row.path).toMatch(
                new RegExp(`^(${FG_SHARED}|${FG_PER_FRAME})\\.`)
            );
        }
        const enhancedMr =
            iodIndex.ciods[iodIndex.sops["1.2.840.10008.5.1.4.1.1.4.1"]];
        expect(enhancedMr.modules.some(m => m.id === "fg:pixel-measures")).toBe(
            true
        );
    });
});

describe("spot checks", () => {
    test("CT Image Storage resolves with core modules and Rows Type 1", () => {
        const iod = getIodForSopClass("1.2.840.10008.5.1.4.1.1.2");
        expect(iod.ciodId).toBe("ct-image");
        expect(iod.name).toBe("CT Image");
        const ids = iod.modules.map(m => m.id);
        expect(ids).toEqual(
            expect.arrayContaining(["patient", "general-study", "image-pixel"])
        );
        const pixel = getModuleAttributes("image-pixel");
        expect(pixel.find(r => r.path === "00280010")).toEqual({
            path: "00280010",
            type: "1"
        });
    });

    test("unknown SOP Class returns null", () => {
        expect(getIodForSopClass("1.2.3.4.5")).toBeNull();
    });

    test("JSON-Schema projection declares 2020-12 and the source metadata", () => {
        const schema = JSON.parse(
            readFileSync(join(root, "schema", "iod.schema.json"), "utf8")
        );
        expect(schema.$schema).toBe(
            "https://json-schema.org/draft/2020-12/schema"
        );
        expect(schema["x-dicom-source-edition"]).toBe(iodIndex.sourceEdition);
        expect(schema["x-dicom-source-hash"]).toBe(iodIndex.sourceHash);
        expect(schema.$defs.moduleRef.properties.usage.enum).toEqual([
            "M",
            "C",
            "U"
        ]);
    });
});
