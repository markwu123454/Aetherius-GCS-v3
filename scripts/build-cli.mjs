/**
 * Builds aetherius-cli and copies it to src-tauri/binaries/ under the name
 * Tauri's `bundle.externalBin` expects (`aetherius-cli-<target triple>.exe`),
 * so the installer ships it next to the app.
 *
 * Runs before both `tauri dev` and `tauri build`: Tauri copies external
 * binaries on every build and fails if one is missing. The Tauri CLI sets
 * TAURI_ENV_TARGET_TRIPLE and TAURI_ENV_DEBUG for these commands; run on its
 * own, this builds a release binary for this machine.
 */
import {execFileSync} from "node:child_process";
import {copyFileSync, mkdirSync} from "node:fs";
import {join} from "node:path";
import {fileURLToPath} from "node:url";

const TAURI_DIR = fileURLToPath(new URL("../src-tauri", import.meta.url));

const host = /^host: (\S+)$/m.exec(execFileSync("rustc", ["-vV"], {encoding: "utf8"}))[1];
const triple = process.env.TAURI_ENV_TARGET_TRIPLE || host;
const debug = process.env.TAURI_ENV_DEBUG === "true";
const crossBuild = triple !== host;

const args = ["build", "-p", "aetherius-cli"];
if (!debug) args.push("--release");
if (crossBuild) args.push("--target", triple);
execFileSync("cargo", args, {cwd: TAURI_DIR, stdio: "inherit"});

const ext = triple.includes("windows") ? ".exe" : "";
const targetDir = process.env.CARGO_TARGET_DIR || join(TAURI_DIR, "target");
const built = join(targetDir, ...(crossBuild ? [triple] : []), debug ? "debug" : "release", `aetherius-cli${ext}`);
mkdirSync(join(TAURI_DIR, "binaries"), {recursive: true});
copyFileSync(built, join(TAURI_DIR, "binaries", `aetherius-cli-${triple}${ext}`));
