//! Every command, defined once. The CLI parses arguments and prints `help`
//! from this; the app checks permissions against it.

use std::sync::OnceLock;

/// The permission category a command falls under — the rows of
/// Settings › CLI › Permissions. `Always` is allowed whatever the settings
/// say (`help`, `requests`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Category {
    Reads,
    Logs,
    Params,
    Scripts,
    Reboot,
    Always,
}

impl Category {
    pub fn key(self) -> &'static str {
        match self {
            Category::Reads => "reads",
            Category::Logs => "logs",
            Category::Params => "params",
            Category::Scripts => "scripts",
            Category::Reboot => "reboot",
            Category::Always => "always",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Category::Reads => "reads",
            Category::Logs => "log files",
            Category::Params => "parameter writes",
            Category::Scripts => "script writes",
            Category::Reboot => "reboot",
            Category::Always => "always allowed",
        }
    }
}

#[derive(Clone, Debug)]
pub struct ArgDef {
    /// Key in the request's `args` object.
    pub key: &'static str,
    /// How the synopsis names it.
    pub name: &'static str,
    /// Argument type, as `help --json` reports it.
    pub kind: &'static str,
    pub required: bool,
    /// Takes every remaining positional argument.
    pub repeat: bool,
    pub help: &'static str,
}

#[derive(Clone, Debug)]
pub struct OptDef {
    pub flag: &'static str,
    pub key: &'static str,
    /// The value's name in help (`N`, `DIR`); `None` for a plain flag.
    pub value: Option<&'static str>,
    /// `flag` for a plain flag, otherwise the value's type.
    pub kind: &'static str,
    /// May be given more than once (or comma-separated); collected into a list.
    pub repeat: bool,
    pub help: &'static str,
}

#[derive(Clone, Debug)]
pub struct CommandDef {
    pub name: &'static str,
    pub synopsis: &'static str,
    pub summary: &'static str,
    pub description: &'static str,
    pub category: Category,
    /// While armed applies to this command.
    pub while_armed: bool,
    pub needs_vehicle: bool,
    /// Prints items as they happen and runs until stopped.
    pub streams: bool,
    /// Handled entirely by the CLI; never sent to the app.
    pub local: bool,
    pub args: Vec<ArgDef>,
    pub options: Vec<OptDef>,
    pub errors: Vec<&'static str>,
    pub example: &'static str,
    /// Reply `data` shape, in `shape.rs` notation.
    pub data: &'static str,
    /// Streamed item shape, for commands that stream.
    pub item: Option<&'static str>,
}

pub struct GlobalOption {
    pub flag: &'static str,
    pub value: Option<&'static str>,
    pub kind: &'static str,
    pub default: Option<&'static str>,
    pub help: &'static str,
}

pub const GLOBAL_OPTIONS: &[GlobalOption] = &[
    GlobalOption { flag: "--json", value: None, kind: "flag", default: None, help: "JSON output" },
    GlobalOption {
        flag: "--timeout",
        value: Some("DURATION"),
        kind: "duration",
        default: Some("10m"),
        help: "how long to wait for approval; 0 waits forever",
    },
    GlobalOption {
        flag: "--no-wait",
        value: None,
        kind: "flag",
        default: None,
        help: "return once the request is waiting (exit 9); finish with requests wait",
    },
    GlobalOption { flag: "--quiet", value: None, kind: "flag", default: None, help: "no status lines on stderr" },
    GlobalOption { flag: "--help", value: None, kind: "flag", default: None, help: "help for the command it follows" },
    GlobalOption { flag: "--version", value: None, kind: "flag", default: None, help: "print the CLI version" },
];

fn arg(key: &'static str, name: &'static str, kind: &'static str, required: bool, repeat: bool, help: &'static str) -> ArgDef {
    ArgDef { key, name, kind, required, repeat, help }
}

fn flag(flag: &'static str, key: &'static str, help: &'static str) -> OptDef {
    OptDef { flag, key, value: None, kind: "flag", repeat: false, help }
}

fn opt(flag: &'static str, key: &'static str, value: &'static str, kind: &'static str, help: &'static str) -> OptDef {
    OptDef { flag, key, value: Some(value), kind, repeat: false, help }
}

fn opts(flag: &'static str, key: &'static str, value: &'static str, kind: &'static str, help: &'static str) -> OptDef {
    OptDef { flag, key, value: Some(value), kind, repeat: true, help }
}

fn range_options() -> Vec<OptDef> {
    vec![
        opt("--from", "from", "T", "time", "start, in log seconds or m:ss"),
        opt("--to", "to", "T", "time", "end, in log seconds or m:ss"),
        opt("--mode", "mode", "NAME[#N]", "text", "the Nth time the vehicle was in that mode (default the first)"),
        flag("--armed", "armed", "only while armed"),
    ]
}

fn with(mut base: Vec<OptDef>, extra: Vec<OptDef>) -> Vec<OptDef> {
    base.extend(extra);
    base
}

const VEHICLE: &[&str] = &["no_vehicle"];
const APPROVAL: &[&str] = &["blocked", "rejected", "expired"];

fn errs(groups: &[&[&'static str]]) -> Vec<&'static str> {
    groups.iter().flat_map(|g| g.iter().copied()).collect()
}

const STATS_SHAPE: &str = "{fields: [{field: string, n: integer, min: number, max: number, mean: number, rms: number, std: number, p5: number, p50: number, p95: number}]}";
const SERIES_SHAPE: &str = "{columns: [string], rows: [[number]], samples: integer, averaged: boolean}";
const FFT_SHAPE: &str = "{sampleRate: number, resolution: number, seconds: number, fields: [{field: string, peaks: [{hz: number, db: number}], bins: [{hz: number, db: number}]?}]}";
const CHANGE_SHAPE: &str = "{changes: [{name: string, from: number, to: number, confirmed: boolean, error: string?}], unchanged: [string], skipped: [string], applied: integer, total: integer, rebootNeeded: boolean, dryRun: boolean}";

fn build() -> Vec<CommandDef> {
    vec![
        CommandDef {
            name: "status",
            synopsis: "status",
            summary: "link, vehicle and CLI settings",
            description: "What's connected, the vehicle's state, how many parameters are loaded, and what each permission category is set to. Works without a vehicle.",
            category: Category::Reads,
            while_armed: false,
            needs_vehicle: false,
            streams: false,
            local: false,
            args: vec![],
            options: vec![],
            errors: vec![],
            example: "$ aetherius-cli status\nlink        COM5 · CubeOrange\nfirmware    ArduCopter V4.6.2\nstate       disarmed · LOITER\nparams      1043 loaded",
            data: "{link: {endpoint: string, board: string?}?, firmware: string?, vehicle: string?, armed: boolean?, mode: string?, params: {loaded: integer, total: integer?}, permissions: {reads: string, logs: string, params: string, scripts: string, reboot: string, whileArmed: string}}",
            item: None,
        },
        CommandDef {
            name: "params get",
            synopsis: "params get NAME|PATTERN...",
            summary: "parameter values",
            description: "Values from the app's parameter cache. NAME is exact; PATTERN takes * and ? and ignores case. params get '*' lists everything. Names the vehicle doesn't have are listed under missing; unknown_param only if nothing else was found.",
            category: Category::Reads,
            while_armed: false,
            needs_vehicle: true,
            streams: false,
            local: false,
            args: vec![arg("names", "NAME|PATTERN", "pattern", true, true, "one or more names or patterns")],
            options: vec![],
            errors: errs(&[&["unknown_param"], VEHICLE]),
            example: "$ aetherius-cli params get 'INS_HNTCH_*'\nINS_HNTCH_BW       40      Hz\nINS_HNTCH_FREQ     80      Hz\n2 parameters",
            data: "{params: [{name: string, value: number, type: string, units: string?}], missing: [string]}",
            item: None,
        },
        CommandDef {
            name: "params describe",
            synopsis: "params describe NAME|PATTERN...",
            summary: "parameter documentation",
            description: "ArduPilot's documentation for each parameter, with its current value, range, units, value list or bitmask.",
            category: Category::Reads,
            while_armed: false,
            needs_vehicle: true,
            streams: false,
            local: false,
            args: vec![arg("names", "NAME|PATTERN", "pattern", true, true, "one or more names or patterns")],
            options: vec![],
            errors: errs(&[&["unknown_param"], VEHICLE]),
            example: "$ aetherius-cli params describe INS_HNTCH_FREQ\nINS_HNTCH_FREQ   Harmonic Notch Filter base frequency\nvalue            80 Hz\nrange            10 – 495 Hz",
            data: "{params: [{name: string, humanName: string?, description: string?, value: number?, units: string?, range: [number]?, increment: number?, values: [{value: number, label: string}]?, bitmask: [{bit: integer, label: string, set: boolean}]?, level: string?, rebootRequired: boolean}], missing: [string]}",
            item: None,
        },
        CommandDef {
            name: "params set",
            synopsis: "params set NAME=VALUE... [--dry-run] [--allow-out-of-range]",
            summary: "change parameters",
            description: "Change one or more parameters. Every value is checked before anything is sent; one bad value fails the whole request. Values equal to the current ones are dropped.",
            category: Category::Params,
            while_armed: true,
            needs_vehicle: true,
            streams: false,
            local: false,
            args: vec![arg("assignments", "NAME=VALUE", "assignment", true, true, "one or more; exact names")],
            options: vec![
                flag("--dry-run", "dryRun", "check and show the changes, send nothing (counts as reads)"),
                flag("--allow-out-of-range", "allowOutOfRange", "allow values outside the documented range; always asks"),
            ],
            errors: errs(&[&["usage", "unknown_param", "invalid_value", "out_of_range"], VEHICLE, APPROVAL, &["vehicle_error"]]),
            example: "$ aetherius-cli params set INS_HNTCH_FREQ=160 INS_HNTCH_BW=80\nINS_HNTCH_FREQ   80 → 160\nINS_HNTCH_BW     40 → 80\napplied 2 of 2",
            data: CHANGE_SHAPE,
            item: None,
        },
        CommandDef {
            name: "params diff",
            synopsis: "params diff FILE",
            summary: "compare a .param file with the vehicle",
            description: "Compares a .param file (NAME,VALUE per line) with the live values.",
            category: Category::Reads,
            while_armed: false,
            needs_vehicle: true,
            streams: false,
            local: false,
            args: vec![arg("file", "FILE", "path", true, false, "a .param file")],
            options: vec![],
            errors: errs(&[&["not_found", "bad_file", "io_error"], VEHICLE]),
            example: "$ aetherius-cli params diff tuned.param\nATC_RAT_RLL_P    0.135 → 0.15\n1 differ · 1042 same",
            data: "{differ: [{name: string, live: number, file: number}], same: integer, missing: [string]}",
            item: None,
        },
        CommandDef {
            name: "params apply",
            synopsis: "params apply FILE [--only PATTERN...] [--allow-out-of-range]",
            summary: "apply a .param file",
            description: "The same as params set with every value in the file that differs from the vehicle, or only those matching --only. Names the vehicle doesn't have are skipped.",
            category: Category::Params,
            while_armed: true,
            needs_vehicle: true,
            streams: false,
            local: false,
            args: vec![arg("file", "FILE", "path", true, false, "a .param file")],
            options: vec![
                opts("--only", "only", "PATTERN", "pattern", "only parameters matching these patterns"),
                flag("--allow-out-of-range", "allowOutOfRange", "allow values outside the documented range; always asks"),
            ],
            errors: errs(&[&["not_found", "bad_file", "io_error", "invalid_value", "out_of_range"], VEHICLE, APPROVAL, &["vehicle_error"]]),
            example: "$ aetherius-cli params apply tuned.param\nATC_RAT_RLL_P    0.135 → 0.15\napplied 1 of 1",
            data: CHANGE_SHAPE,
            item: None,
        },
        CommandDef {
            name: "params save",
            synopsis: "params save FILE [PATTERN...] [--force]",
            summary: "save parameters to a .param file",
            description: "Writes live values to a .param file, the same format the Parameters page saves. Won't overwrite an existing file without --force.",
            category: Category::Reads,
            while_armed: false,
            needs_vehicle: true,
            streams: false,
            local: false,
            args: vec![
                arg("file", "FILE", "path", true, false, "where to save"),
                arg("patterns", "PATTERN", "pattern", false, true, "only parameters matching these"),
            ],
            options: vec![flag("--force", "force", "overwrite an existing file")],
            errors: errs(&[&["io_error"], VEHICLE]),
            example: "$ aetherius-cli params save before.param\nsaved 1043 parameters to C:\\Users\\me\\before.param",
            data: "{path: string, count: integer}",
            item: None,
        },
        CommandDef {
            name: "params refresh",
            synopsis: "params refresh",
            summary: "fetch every parameter again",
            description: "Fetches every parameter from the vehicle again, with progress on stderr.",
            category: Category::Reads,
            while_armed: false,
            needs_vehicle: true,
            streams: false,
            local: false,
            args: vec![],
            options: vec![],
            errors: errs(&[VEHICLE, &["vehicle_error"]]),
            example: "$ aetherius-cli params refresh\n1043 parameters loaded",
            data: "{loaded: integer, total: integer?}",
            item: None,
        },
        CommandDef {
            name: "script ls",
            synopsis: "script ls [DIR]",
            summary: "scripts on the vehicle",
            description: "Lists a folder under APM/scripts on the vehicle's SD card.",
            category: Category::Reads,
            while_armed: false,
            needs_vehicle: true,
            streams: false,
            local: false,
            args: vec![arg("dir", "DIR", "remote-path", false, false, "a folder under APM/scripts")],
            options: vec![],
            errors: errs(&[&["not_found", "vehicle_error"], VEHICLE]),
            example: "$ aetherius-cli script ls\nbatt_warn.lua      1.2 KB\nmodules/",
            data: "{dir: string, entries: [{name: string, bytes: integer?, dir: boolean}]}",
            item: None,
        },
        CommandDef {
            name: "script pull",
            synopsis: "script pull REMOTE [LOCAL] [--force]",
            summary: "copy a script from the vehicle",
            description: "Copies a file from APM/scripts on the vehicle. LOCAL defaults to the file's name in the current folder. Won't overwrite without --force.",
            category: Category::Reads,
            while_armed: false,
            needs_vehicle: true,
            streams: false,
            local: false,
            args: vec![
                arg("remote", "REMOTE", "remote-path", true, false, "a file under APM/scripts"),
                arg("local", "LOCAL", "path", false, false, "where to save it"),
            ],
            options: vec![flag("--force", "force", "overwrite an existing file")],
            errors: errs(&[&["not_found", "io_error", "vehicle_error"], VEHICLE]),
            example: "$ aetherius-cli script pull batt_warn.lua\npulled APM/scripts/batt_warn.lua → .\\batt_warn.lua (1.2 KB)",
            data: "{remote: string, local: string, bytes: integer}",
            item: None,
        },
        CommandDef {
            name: "script push",
            synopsis: "script push LOCAL... [--to DIR] [--no-restart]\nscript push --watch DIR [--to DIR]",
            summary: "upload scripts, restart scripting",
            description: "Uploads Lua files to APM/scripts, restarts scripting and watches the console for 3 s; a Lua error fails the command with script_error. With --watch, one approval covers the session and every saved .lua file in DIR is pushed until Ctrl+C or Stop.",
            category: Category::Scripts,
            while_armed: true,
            needs_vehicle: true,
            streams: false,
            local: false,
            args: vec![arg("files", "LOCAL", "path", false, true, "Lua files to upload")],
            options: vec![
                opt("--to", "to", "DIR", "remote-path", "folder under APM/scripts (default APM/scripts)"),
                flag("--no-restart", "noRestart", "don't restart scripting afterwards"),
                opt("--watch", "watch", "DIR", "path", "push every .lua file saved in DIR until stopped"),
            ],
            errors: errs(&[&["usage", "not_found", "io_error", "script_error", "vehicle_error", "stopped"], VEHICLE, APPROVAL]),
            example: "$ aetherius-cli script push vibe_watch.lua\nuploaded vibe_watch.lua → APM/scripts/vibe_watch.lua (214 B, new)\nscripting restarted\nno Lua errors",
            data: "{files: [{local: string, remote: string, bytes: integer, new: boolean}], restarted: boolean, rebootNeeded: boolean, luaErrors: [string], pushed: integer?, held: integer?}",
            item: Some("{time: string, file: string, result: string, reason: string?, luaErrors: [string]}"),
        },
        CommandDef {
            name: "script rm",
            synopsis: "script rm REMOTE [--no-restart]",
            summary: "delete a script",
            description: "Deletes a file under APM/scripts on the vehicle and restarts scripting.",
            category: Category::Scripts,
            while_armed: true,
            needs_vehicle: true,
            streams: false,
            local: false,
            args: vec![arg("remote", "REMOTE", "remote-path", true, false, "a file under APM/scripts")],
            options: vec![flag("--no-restart", "noRestart", "don't restart scripting afterwards")],
            errors: errs(&[&["not_found", "script_error", "vehicle_error"], VEHICLE, APPROVAL]),
            example: "$ aetherius-cli script rm old_test.lua\nremoved APM/scripts/old_test.lua\nscripting restarted",
            data: "{removed: string, restarted: boolean, rebootNeeded: boolean, luaErrors: [string]}",
            item: None,
        },
        CommandDef {
            name: "script restart",
            synopsis: "script restart",
            summary: "restart scripting",
            description: "Restarts Lua scripting on the vehicle and watches the console for 3 s for errors.",
            category: Category::Scripts,
            while_armed: true,
            needs_vehicle: true,
            streams: false,
            local: false,
            args: vec![],
            options: vec![],
            errors: errs(&[&["script_error", "vehicle_error"], VEHICLE, APPROVAL]),
            example: "$ aetherius-cli script restart\nscripting restarted\nno Lua errors",
            data: "{restarted: boolean, rebootNeeded: boolean, luaErrors: [string]}",
            item: None,
        },
        CommandDef {
            name: "console",
            synopsis: "console [--last N] [--since TIME] [--level LEVEL] [--grep TEXT] [--follow]",
            summary: "vehicle text messages",
            description: "The vehicle's text messages since the link connected — the same ones the Console panel shows. LEVEL is the lowest severity to show: emergency, alert, critical, error, warning, notice, info, debug.",
            category: Category::Reads,
            while_armed: false,
            needs_vehicle: false,
            streams: false,
            local: false,
            args: vec![],
            options: vec![
                opt("--last", "last", "N", "integer", "the last N messages (default 50)"),
                opt("--since", "since", "TIME", "time", "HH:MM:SS, or a time back from now (5m)"),
                opt("--level", "level", "LEVEL", "text", "lowest severity to show"),
                opt("--grep", "grep", "TEXT", "text", "only messages containing TEXT"),
                flag("--follow", "follow", "keep printing new messages until Ctrl+C or Stop"),
            ],
            errors: vec!["usage", "stopped"],
            example: "$ aetherius-cli console --since 5m --level warning\n14:02:11  warning   PreArm: Compass not calibrated",
            data: "{messages: [{time: string, severity: string, text: string}]}",
            item: Some("{time: string, severity: string, text: string}"),
        },
        CommandDef {
            name: "logs ls",
            synopsis: "logs ls",
            summary: "logs on the vehicle",
            description: "Lists the dataflash logs on the vehicle.",
            category: Category::Logs,
            while_armed: false,
            needs_vehicle: true,
            streams: false,
            local: false,
            args: vec![],
            options: vec![],
            errors: errs(&[VEHICLE, &["vehicle_error"]]),
            example: "$ aetherius-cli logs ls\nid   date               size\n42   2026-11-13 13:53   38.2 MB",
            data: "{logs: [{id: integer, time: string?, bytes: integer}]}",
            item: None,
        },
        CommandDef {
            name: "logs pull",
            synopsis: "logs pull ID|latest",
            summary: "download a log",
            description: "Downloads a log into the vehicle's log folder, with progress on stderr. A log already downloaded returns at once; a different log saved under the same number is kept and the new one gets the next free name.",
            category: Category::Logs,
            while_armed: true,
            needs_vehicle: true,
            streams: false,
            local: false,
            args: vec![arg("id", "ID|latest", "log", true, false, "a log number, or latest")],
            options: vec![],
            errors: errs(&[&["not_found", "vehicle_error", "stopped"], VEHICLE, APPROVAL]),
            example: "$ aetherius-cli logs pull 42\npulled log 42 → 00000042.bin (38.2 MB, 18.4 s)",
            data: "{id: integer, file: string, path: string, bytes: integer, seconds: number, alreadySaved: boolean, earlier: string?}",
            item: None,
        },
        CommandDef {
            name: "logs local",
            synopsis: "logs local",
            summary: "downloaded logs",
            description: "Logs already downloaded for the connected vehicle, oldest first. on vehicle marks those matching a log the vehicle still has.",
            category: Category::Logs,
            while_armed: false,
            needs_vehicle: false,
            streams: false,
            local: false,
            args: vec![],
            options: vec![],
            errors: vec![],
            example: "$ aetherius-cli logs local\nid   file             size      downloaded         on vehicle\n42   00000042-2.bin   38.2 MB   2026-11-13 14:02   yes",
            data: "{logs: [{id: integer, file: string, path: string, bytes: integer, downloaded: string, onVehicle: boolean?}]}",
            item: None,
        },
        CommandDef {
            name: "logs info",
            synopsis: "logs info LOG",
            summary: "file, firmware, duration",
            description: "What a log file holds. LOG is a log number, latest, a file name from logs local, or a path to a .bin file.",
            category: Category::Logs,
            while_armed: false,
            needs_vehicle: false,
            streams: false,
            local: false,
            args: vec![arg("log", "LOG", "log", true, false, "log number, latest, file name or path")],
            options: vec![],
            errors: vec!["not_found", "bad_file", "no_vehicle"],
            example: "$ aetherius-cli logs info 42\nfile        00000042.bin · 38.2 MB\nfirmware    ArduCopter V4.6.2\nduration    7:20",
            data: "{file: string, path: string, bytes: integer, firmware: string?, start: string?, duration: number, types: integer, records: integer}",
            item: None,
        },
        CommandDef {
            name: "logs schema",
            synopsis: "logs schema LOG [MSG]",
            summary: "message types and fields",
            description: "Every message type with its rate, or one message's fields and units.",
            category: Category::Logs,
            while_armed: false,
            needs_vehicle: false,
            streams: false,
            local: false,
            args: vec![
                arg("log", "LOG", "log", true, false, "log number, latest, file name or path"),
                arg("message", "MSG", "text", false, false, "one message type"),
            ],
            options: vec![],
            errors: vec!["not_found", "bad_file", "no_vehicle"],
            example: "$ aetherius-cli logs schema 42 RATE\nRATE   400 Hz   114,820 records\nfield   unit\nRDes    deg/s",
            data: "{messages: [{name: string, rate: number, count: integer, fields: [{name: string, unit: string?}]}]}",
            item: None,
        },
        CommandDef {
            name: "logs series",
            synopsis: "logs series LOG FIELD[,FIELD...] [range] [--rate HZ] [--max N]",
            summary: "values over time",
            description: "Values over time. FIELD is MSG.Field, or MSG[N].Field for instance N. Fields are lined up on the first field's timestamps, or on a fixed rate with --rate. More rows than --max (default 200) are averaged into equal time slices.",
            category: Category::Logs,
            while_armed: false,
            needs_vehicle: false,
            streams: false,
            local: false,
            args: vec![
                arg("log", "LOG", "log", true, false, "log number, latest, file name or path"),
                arg("fields", "FIELDS", "fields", true, false, "comma-separated MSG.Field list"),
            ],
            options: with(
                range_options(),
                vec![
                    opt("--rate", "rate", "HZ", "number", "resample onto a fixed rate"),
                    opt("--max", "max", "N", "integer", "most rows to print (default 200)"),
                ],
            ),
            errors: vec!["usage", "not_found", "bad_file", "no_vehicle"],
            example: "$ aetherius-cli logs series 42 RATE.RDes,RATE.R --mode Loiter --max 2\nt        RATE.RDes   RATE.R\n2:10.0     0.0         0.4\n2 rows · averaged from 113,950 samples",
            data: SERIES_SHAPE,
            item: None,
        },
        CommandDef {
            name: "logs events",
            synopsis: "logs events LOG [TYPE...]",
            summary: "messages, errors, events, modes",
            description: "TYPE is MSG (text messages), ERR (subsystem errors), EV (events) or MODE. Default all four.",
            category: Category::Logs,
            while_armed: false,
            needs_vehicle: false,
            streams: false,
            local: false,
            args: vec![
                arg("log", "LOG", "log", true, false, "log number, latest, file name or path"),
                arg("types", "TYPE", "text", false, true, "MSG, ERR, EV or MODE"),
            ],
            options: vec![],
            errors: vec!["usage", "not_found", "bad_file", "no_vehicle"],
            example: "$ aetherius-cli logs events 42 MODE\n0:41.2   MODE   ALT HOLD",
            data: "{events: [{t: number, type: string, text: string}]}",
            item: None,
        },
        CommandDef {
            name: "logs segments",
            synopsis: "logs segments LOG",
            summary: "modes and armed state over time",
            description: "Flight modes and armed state over the log, in log seconds.",
            category: Category::Logs,
            while_armed: false,
            needs_vehicle: false,
            streams: false,
            local: false,
            args: vec![arg("log", "LOG", "log", true, false, "log number, latest, file name or path")],
            options: vec![],
            errors: vec!["not_found", "bad_file", "no_vehicle"],
            example: "$ aetherius-cli logs segments 42\nmode        from    to      armed\nLOITER      2:10    6:55    yes",
            data: "{segments: [{mode: string, from: number, to: number, armed: boolean}], armed: [{from: number, to: number}]}",
            item: None,
        },
        CommandDef {
            name: "logs stats",
            synopsis: "logs stats LOG FIELD[,FIELD...] [range]",
            summary: "min, max, mean, rms, percentiles",
            description: "Statistics over full-rate samples.",
            category: Category::Logs,
            while_armed: false,
            needs_vehicle: false,
            streams: false,
            local: false,
            args: vec![
                arg("log", "LOG", "log", true, false, "log number, latest, file name or path"),
                arg("fields", "FIELDS", "fields", true, false, "comma-separated MSG.Field list"),
            ],
            options: range_options(),
            errors: vec!["usage", "not_found", "bad_file", "not_enough_data", "no_vehicle"],
            example: "$ aetherius-cli logs stats 42 VIBE.VibeX --mode Loiter\nfield        n      min    max    mean   rms    p95\nVIBE.VibeX   2850   3.1    18.4   7.2    7.9    12.6",
            data: STATS_SHAPE,
            item: None,
        },
        CommandDef {
            name: "logs fft",
            synopsis: "logs fft LOG FIELD[,FIELD...] [range] [--peaks N] [--bins N] [--nfft N]",
            summary: "frequency peaks",
            description: "Power spectrum (Welch: Hann window, 1024-point segments by default, 50% overlap) with the top --peaks peaks per field (default 3). --bins N adds the spectrum averaged into N bins.",
            category: Category::Logs,
            while_armed: false,
            needs_vehicle: false,
            streams: false,
            local: false,
            args: vec![
                arg("log", "LOG", "log", true, false, "log number, latest, file name or path"),
                arg("fields", "FIELDS", "fields", true, false, "comma-separated MSG.Field list"),
            ],
            options: with(
                range_options(),
                vec![
                    opt("--peaks", "peaks", "N", "integer", "peaks per field (default 3)"),
                    opt("--bins", "bins", "N", "integer", "include the spectrum in N bins"),
                    opt("--nfft", "nfft", "N", "integer", "segment length, a power of two (default 1024)"),
                ],
            ),
            errors: vec!["usage", "not_found", "bad_file", "not_enough_data", "no_vehicle"],
            example: "$ aetherius-cli logs fft 42 IMU.GyrX --mode Loiter\nsample rate 1000 Hz · resolution 0.98 Hz · 285 s\nfield      peak 1           peak 2\nIMU.GyrX   162 Hz  -18 dB   324 Hz  -31 dB",
            data: FFT_SHAPE,
            item: None,
        },
        CommandDef {
            name: "logs track-error",
            synopsis: "logs track-error LOG DESIRED,ACTUAL [range]",
            summary: "how well one field follows another",
            description: "How well ACTUAL follows DESIRED, lined up on DESIRED's timestamps. Lag is the delay with the highest cross-correlation.",
            category: Category::Logs,
            while_armed: false,
            needs_vehicle: false,
            streams: false,
            local: false,
            args: vec![
                arg("log", "LOG", "log", true, false, "log number, latest, file name or path"),
                arg("fields", "DESIRED,ACTUAL", "fields", true, false, "two fields"),
            ],
            options: range_options(),
            errors: vec!["usage", "not_found", "bad_file", "not_enough_data", "no_vehicle"],
            example: "$ aetherius-cli logs track-error 42 RATE.RDes,RATE.R --mode Loiter\nrms 4.1 deg/s · max 22.6 deg/s · mean 0.2 deg/s · lag 18 ms · 113,950 samples",
            data: "{rms: number, max: number, mean: number, lagMs: number, samples: integer, units: string?}",
            item: None,
        },
        CommandDef {
            name: "logs eval",
            synopsis: "logs eval LOG \"EXPR\" [range] [--stats | --series | --fft]",
            summary: "expression over fields",
            description: "Works out an expression over fields, lined up on the first field's timestamps, and shows it like stats (default), series or fft. Expressions use fields, numbers, + - * / ^, parentheses, abs sqrt sin cos atan2 hypot min max deg rad, diff(x) (rate of change per second) and lpf(x, HZ) (low-pass filter). data is the chosen output's shape.",
            category: Category::Logs,
            while_armed: false,
            needs_vehicle: false,
            streams: false,
            local: false,
            args: vec![
                arg("log", "LOG", "log", true, false, "log number, latest, file name or path"),
                arg("expr", "EXPR", "expr", true, false, "the expression"),
            ],
            options: with(
                range_options(),
                vec![
                    flag("--stats", "stats", "show statistics (default)"),
                    flag("--series", "series", "show values over time"),
                    flag("--fft", "fft", "show the spectrum"),
                    opt("--rate", "rate", "HZ", "number", "series: resample onto a fixed rate"),
                    opt("--max", "max", "N", "integer", "series: most rows (default 200)"),
                    opt("--peaks", "peaks", "N", "integer", "fft: peaks (default 3)"),
                    opt("--bins", "bins", "N", "integer", "fft: include the spectrum in N bins"),
                    opt("--nfft", "nfft", "N", "integer", "fft: segment length (default 1024)"),
                ],
            ),
            errors: vec!["usage", "not_found", "bad_file", "not_enough_data", "no_vehicle"],
            example: "$ aetherius-cli logs eval 42 \"hypot(VIBE.VibeX, VIBE.VibeY)\" --mode Loiter\nfield   n      min   max    mean   rms    p95\nexpr    2850   4.4   24.1   10.3   11.2   17.9",
            data: STATS_SHAPE,
            item: None,
        },
        CommandDef {
            name: "logs export",
            synopsis: "logs export LOG FIELD[,FIELD...] --out FILE [range] [--rate HZ] [--format csv|jsonl] [--force]",
            summary: "full-rate data to a file",
            description: "Full-rate data to a file, for analysis the other commands don't cover. The first column is t_us. Takes text fields too (PARM.Name, MSG.Message); text from another message than the first field's holds its latest value. Won't overwrite without --force.",
            category: Category::Logs,
            while_armed: false,
            needs_vehicle: false,
            streams: false,
            local: false,
            args: vec![
                arg("log", "LOG", "log", true, false, "log number, latest, file name or path"),
                arg("fields", "FIELDS", "fields", true, false, "comma-separated MSG.Field list"),
            ],
            options: with(
                range_options(),
                vec![
                    opt("--out", "out", "FILE", "path", "where to write"),
                    opt("--rate", "rate", "HZ", "number", "resample onto a fixed rate"),
                    opt("--format", "format", "csv|jsonl", "text", "file format (default csv)"),
                    flag("--force", "force", "overwrite an existing file"),
                ],
            ),
            errors: vec!["usage", "not_found", "bad_file", "io_error", "no_vehicle"],
            example: "$ aetherius-cli logs export 42 RATE.RDes,RATE.R --out rate.csv\nexported 113,950 rows → rate.csv",
            data: "{path: string, rows: integer, columns: [string]}",
            item: None,
        },
        CommandDef {
            name: "reboot",
            synopsis: "reboot [--no-reconnect]",
            summary: "reboot and wait for the link",
            description: "Reboots the vehicle and waits up to 60 s for the link to come back and the parameters to reload. Never sends ArduPilot's armed override, so an armed vehicle refuses.",
            category: Category::Reboot,
            while_armed: true,
            needs_vehicle: true,
            streams: false,
            local: false,
            args: vec![],
            options: vec![flag("--no-reconnect", "noReconnect", "don't wait for the link to come back")],
            errors: errs(&[VEHICLE, APPROVAL, &["vehicle_error"]]),
            example: "$ aetherius-cli reboot\nrebooting\nlink back after 9.8 s · 1043 parameters loaded",
            data: "{reconnected: boolean, seconds: number?, params: integer?}",
            item: None,
        },
        CommandDef {
            name: "requests ls",
            synopsis: "requests ls [--all]",
            summary: "requests in this app session",
            description: "Waiting and running requests; --all adds finished ones.",
            category: Category::Always,
            while_armed: false,
            needs_vehicle: false,
            streams: false,
            local: false,
            args: vec![],
            options: vec![flag("--all", "all", "include finished requests")],
            errors: vec![],
            example: "$ aetherius-cli requests ls\nid    time      state     command\nr42   14:04:12  waiting   params set INS_HNTCH_FREQ=160",
            data: "{requests: [{id: string, time: string, state: string, command: string, folder: string?}]}",
            item: None,
        },
        CommandDef {
            name: "requests show",
            synopsis: "requests show ID",
            summary: "a finished request's reply",
            description: "Prints a finished request's reply the way the original command printed it.",
            category: Category::Always,
            while_armed: false,
            needs_vehicle: false,
            streams: false,
            local: false,
            args: vec![arg("id", "ID", "text", true, false, "a request id such as r42")],
            options: vec![],
            errors: vec!["not_found"],
            example: "$ aetherius-cli requests show r42",
            data: "any",
            item: None,
        },
        CommandDef {
            name: "requests wait",
            synopsis: "requests wait ID",
            summary: "wait for a request started with --no-wait",
            description: "Waits for a request, then prints its reply and exits with the code the original command would have used.",
            category: Category::Always,
            while_armed: false,
            needs_vehicle: false,
            streams: false,
            local: false,
            args: vec![arg("id", "ID", "text", true, false, "a request id such as r42")],
            options: vec![],
            errors: vec!["not_found"],
            example: "$ aetherius-cli requests wait r42",
            data: "any",
            item: None,
        },
        CommandDef {
            name: "requests stop",
            synopsis: "requests stop ID",
            summary: "stop a waiting or running request",
            description: "Stops a waiting or running request, the same as Stop in the panel.",
            category: Category::Always,
            while_armed: false,
            needs_vehicle: false,
            streams: false,
            local: false,
            args: vec![arg("id", "ID", "text", true, false, "a request id such as r42")],
            options: vec![],
            errors: vec!["not_found"],
            example: "$ aetherius-cli requests stop r45\nstopped r45",
            data: "{stopped: string}",
            item: None,
        },
        CommandDef {
            name: "help",
            synopsis: "help [COMMAND] [--json]\nhelp errors",
            summary: "this list, or one command in detail",
            description: "Built into the CLI; works without the app running.",
            category: Category::Always,
            while_armed: false,
            needs_vehicle: false,
            streams: false,
            local: true,
            args: vec![arg("topic", "COMMAND", "text", false, true, "a command, or errors")],
            options: vec![],
            errors: vec![],
            example: "$ aetherius-cli help params set",
            data: "any",
            item: None,
        },
    ]
}

pub fn commands() -> &'static [CommandDef] {
    static COMMANDS: OnceLock<Vec<CommandDef>> = OnceLock::new();
    COMMANDS.get_or_init(build)
}

pub fn find(name: &str) -> Option<&'static CommandDef> {
    commands().iter().find(|c| c.name == name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shape;

    #[test]
    fn every_shape_parses() {
        for command in commands() {
            shape::parse(command.data).unwrap_or_else(|e| panic!("{}: {e}", command.name));
            if let Some(item) = command.item {
                shape::parse(item).unwrap_or_else(|e| panic!("{} item: {e}", command.name));
            }
        }
    }

    #[test]
    fn every_error_code_is_known() {
        for command in commands() {
            for code in &command.errors {
                assert!(crate::protocol::ERRORS.iter().any(|(c, _, _)| c == code), "{}: {code}", command.name);
            }
        }
    }

    #[test]
    fn keys_are_unique_per_command() {
        for command in commands() {
            let mut keys: Vec<&str> = command.args.iter().map(|a| a.key).chain(command.options.iter().map(|o| o.key)).collect();
            keys.sort();
            let before = keys.len();
            keys.dedup();
            assert_eq!(before, keys.len(), "{}", command.name);
        }
    }
}
