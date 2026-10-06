// Tyr's version, read once from `package.json` so there is a single source
// of truth. Both `tyr --version` and the `tyrVersion` stamped into
// `.tyr/tyr.json` come from here.

import { readFileSync } from "node:fs";

// Compiled to `dist/cli/core/version.js`, so the manifest is three levels up.
const PACKAGE_JSON_URL = new URL("../../../package.json", import.meta.url);

function readVersion(): string {
    const manifest = JSON.parse(readFileSync(PACKAGE_JSON_URL, "utf8")) as { version?: unknown };
    if (typeof manifest.version !== "string" || manifest.version === "") {
        throw new Error(`No "version" field in ${PACKAGE_JSON_URL.pathname}`);
    }
    return manifest.version;
}

export const TYR_VERSION: string = readVersion();
