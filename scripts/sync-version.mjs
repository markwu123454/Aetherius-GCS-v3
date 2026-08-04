/**
 * Syncs package.json, tauri.conf.json, and Cargo.toml's version to a given
 * tag/version string. The release workflow calls this before building, so a
 * tagged build always ships under the version it was tagged as — including
 * what the updater embeds — without a separate manual version bump first.
 *
 *   node scripts/sync-version.mjs v1.2.3
 *   node scripts/sync-version.mjs 1.2.3
 */
import {readFileSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {fileURLToPath} from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const raw = process.argv[2];
if (!raw) {
    console.error("Usage: node scripts/sync-version.mjs <tag-or-version>");
    process.exit(1);
}

const version = raw.replace(/^v/, "");
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/.test(version)) {
    console.error(`"${raw}" doesn't look like a semantic version (expected e.g. v1.2.3).`);
    process.exit(1);
}

function syncJsonVersion(path) {
    const data = JSON.parse(readFileSync(path, "utf8"));
    data.version = version;
    writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
}

// Cargo.toml isn't JSON, and a global `version = "..."` replace would also
// hit dependency specifiers like `tauri = { version = "2", ... }` — so this
// only touches the version line inside the `[package]` section specifically.
// Split on "\n" alone (not a CRLF-aware split) so a trailing "\r" on
// CRLF-checked-out files stays part of each line's content instead of being
// silently dropped — otherwise `[package]\r` fails the `$`-anchored section
// match and the whole file is skipped.
function syncCargoTomlVersion(path) {
    const lines = readFileSync(path, "utf8").split("\n");
    let inPackage = false;
    let replaced = false;

    for (let i = 0; i < lines.length; i++) {
        const hasCR = lines[i].endsWith("\r");
        const line = hasCR ? lines[i].slice(0, -1) : lines[i];

        const section = line.match(/^\[(.+)]$/);
        if (section) {
            inPackage = section[1] === "package";
            continue;
        }
        if (inPackage && /^version\s*=/.test(line)) {
            lines[i] = `version = "${version}"${hasCR ? "\r" : ""}`;
            replaced = true;
            break;
        }
    }

    if (!replaced) {
        throw new Error(`Could not find a version line in [package] of ${path}`);
    }
    writeFileSync(path, lines.join("\n"));
}

syncJsonVersion(join(ROOT, "package.json"));
syncJsonVersion(join(ROOT, "src-tauri/tauri.conf.json"));
syncCargoTomlVersion(join(ROOT, "src-tauri/Cargo.toml"));

console.log(`Synced version to ${version} in package.json, tauri.conf.json, and Cargo.toml.`);
