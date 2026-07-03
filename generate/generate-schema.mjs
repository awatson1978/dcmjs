// D22 schema generator CLI — writes the committed artifacts.
// Usage: node generate/generate-schema.mjs
// Pure logic lives in buildCatalog.mjs (jest-importable, no import.meta);
// this shell owns filesystem paths and writes. Deterministic output.
import { mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import {
    buildCatalog,
    catalogSource,
    typesSource
} from "./buildCatalog.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

try {
    const catalog = buildCatalog();
    mkdirSync(join(root, "src", "schema"), { recursive: true });
    writeFileSync(
        join(root, "src", "schema", "naturalizedRules.js"),
        catalogSource(catalog)
    );
    console.log("wrote src/schema/naturalizedRules.js");
    mkdirSync(join(root, "types"), { recursive: true });
    writeFileSync(join(root, "types", "dcmjs-schema.d.ts"), typesSource(catalog));
    console.log("wrote types/dcmjs-schema.d.ts");
} catch (err) {
    console.error(`generate-schema FAILED: ${err.message}`);
    process.exit(1);
}
