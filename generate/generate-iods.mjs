// IOD catalog generator CLI — writes the committed artifacts.
// Usage: node generate/generate-iods.mjs
// Pure logic lives in buildIodCatalog.mjs (jest-importable, no import.meta);
// this shell owns filesystem paths and writes. Deterministic output.
// Vendored input data: generate/data/dicom-standard/ (refresh with
// node scripts/refresh-dicom-standard.mjs — pinned upstream commit).
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import prettier from "prettier";
import {
    buildIodCatalog,
    iodIndexSource,
    iodModulesPackedSource,
    iodJsonSchemaSource,
    iodTypesSource
} from "./buildIodCatalog.mjs";
import { naturalizedRules } from "../src/schema/naturalizedRules.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = join(root, "generate", "data", "dicom-standard");

export function loadVendoredData(dir) {
    const read = name => JSON.parse(readFileSync(join(dir, name), "utf8"));
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

try {
    const catalog = buildIodCatalog(loadVendoredData(dataDir));
    mkdirSync(join(root, "src", "schema"), { recursive: true });
    // src/ artifacts go through the repo's prettier config so regeneration
    // stays diff-clean against the commit hooks (same as generate-schema).
    for (const [name, source] of [
        ["iodIndex.js", iodIndexSource(catalog)],
        ["iodModules.packed.js", iodModulesPackedSource(catalog)]
    ]) {
        const outPath = join(root, "src", "schema", name);
        const prettierConfig = prettier.resolveConfig.sync(outPath) || {};
        writeFileSync(
            outPath,
            prettier.format(source, { ...prettierConfig, filepath: outPath })
        );
        console.log(`wrote src/schema/${name}`);
    }
    mkdirSync(join(root, "schema"), { recursive: true });
    writeFileSync(join(root, "schema", "iod.schema.json"), iodJsonSchemaSource(catalog));
    console.log("wrote schema/iod.schema.json");
    // Typed IOD datasets (Workstream D) — raw source, same convention as
    // types/dcmjs-schema.d.ts (generate-schema.mjs writes it unformatted).
    mkdirSync(join(root, "types"), { recursive: true });
    writeFileSync(
        join(root, "types", "dcmjs-iods.d.ts"),
        iodTypesSource(catalog, naturalizedRules.attributes)
    );
    console.log("wrote types/dcmjs-iods.d.ts");
} catch (err) {
    console.error(`generate-iods FAILED: ${err.message}`);
    process.exit(1);
}
