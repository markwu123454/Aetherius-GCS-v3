//! `aetherius-cli` — use a running Aetherius GCS from a terminal.
//!
//! A thin client: it parses the command line against the shared catalog,
//! reads or writes any local files the command involves, and sends one
//! request to the app, which does the work over its own vehicle link and
//! shows the request in its CLI panel.

mod format;
mod help;
mod install;
mod platform;

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::exit;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

use base64::Engine;
use serde_json::{json, Map, Value};

use aetherius_cli::catalog::CommandDef;
use aetherius_cli::parse::{self, Parsed};
use aetherius_cli::protocol::{
    self, ClientMessage, Discovery, Event, Request, APP_IDENTIFIER, DISCOVERY_FILE, EXIT_INTERRUPTED, PROTOCOL,
};

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

/// An error the CLI raises itself, before or after talking to the app.
struct Failure {
    code: &'static str,
    message: String,
}

fn fail(code: &'static str, message: impl Into<String>) -> Failure {
    Failure { code, message: message.into() }
}

fn print_failure(parsed: &Parsed, command: &str, failure: &Failure) -> i32 {
    if parsed.globals.json {
        let body = json!({"ok": false, "command": command, "error": {"code": failure.code, "message": failure.message}});
        println!("{body}");
    } else {
        eprintln!("error: {}: {}", failure.code, failure.message);
    }
    protocol::exit_code(failure.code)
}

fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    // Installer-only, so not in the catalog or help.
    match argv.as_slice() {
        [flag] if flag == "--add-to-path" => exit(install::run(true)),
        [flag] if flag == "--remove-from-path" => exit(install::run(false)),
        _ => {}
    }
    let parsed = match parse::parse(&argv) {
        Ok(p) => p,
        Err(message) => {
            let json = argv.iter().any(|a| a == "--json");
            if json {
                println!("{}", json!({"ok": false, "error": {"code": "usage", "message": message}}));
            } else {
                eprintln!("error: usage: {message}");
            }
            exit(2);
        }
    };

    if parsed.globals.version {
        println!("aetherius-cli {} (protocol {PROTOCOL})", env!("CARGO_PKG_VERSION"));
        return;
    }

    let Some(command) = parsed.command else {
        if parsed.globals.json {
            println!("{}", serde_json::to_string_pretty(&help::catalog_json()).unwrap_or_default());
        } else {
            print!("{}", help::overview());
        }
        return;
    };

    if command.name == "help" || parsed.globals.help {
        exit(run_help(command, &parsed));
    }

    exit(run(command, parsed));
}

fn run_help(command: &'static CommandDef, parsed: &Parsed) -> i32 {
    let target = if command.name == "help" {
        let words: Vec<String> = parsed
            .args
            .get("topic")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
            .unwrap_or_default();
        if words.is_empty() {
            if parsed.globals.json {
                println!("{}", serde_json::to_string_pretty(&help::catalog_json()).unwrap_or_default());
            } else {
                print!("{}", help::overview());
            }
            return 0;
        }
        if words.len() == 1 && words[0] == "errors" {
            if parsed.globals.json {
                println!("{}", serde_json::to_string_pretty(&help::catalog_json()["errors"]).unwrap_or_default());
            } else {
                print!("{}", help::errors());
            }
            return 0;
        }
        match help::find_topic(&words) {
            Some(def) => def,
            None => {
                eprintln!("error: usage: no command '{}' (see aetherius-cli help)", words.join(" "));
                return 2;
            }
        }
    } else {
        command
    };
    if parsed.globals.json {
        println!("{}", serde_json::to_string_pretty(&help::command_json(target)).unwrap_or_default());
    } else {
        print!("{}", help::command(target));
    }
    0
}

fn cwd() -> PathBuf {
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

fn absolute(path: &str) -> PathBuf {
    let p = Path::new(path);
    if p.is_absolute() {
        p.to_path_buf()
    } else {
        cwd().join(p)
    }
}

fn arg_str<'a>(args: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    args.get(key).and_then(Value::as_str)
}

/// What to do with the reply after it arrives, for commands that write
/// local files.
enum After {
    Nothing,
    SaveParams { path: PathBuf },
    WriteScript { path: PathBuf },
    Export { path: PathBuf, jsonl: bool },
}

/// Reads whatever local files the command sends, and checks the ones it will
/// write, before anything goes to the app.
fn prepare(command: &CommandDef, args: &mut Map<String, Value>) -> Result<After, Failure> {
    match command.name {
        "params diff" | "params apply" => {
            let file = arg_str(args, "file").unwrap_or_default().to_string();
            let path = absolute(&file);
            let content = std::fs::read_to_string(&path).map_err(|e| {
                if e.kind() == std::io::ErrorKind::NotFound {
                    fail("not_found", format!("no file {}", path.display()))
                } else {
                    fail("io_error", format!("couldn't read {}: {e}", path.display()))
                }
            })?;
            args.insert("file".into(), json!(path.display().to_string()));
            args.insert("content".into(), json!(content));
            Ok(After::Nothing)
        }
        "params save" => {
            let path = absolute(arg_str(args, "file").unwrap_or_default());
            if path.exists() && args.get("force").is_none() {
                return Err(fail("io_error", format!("{} already exists; use --force to overwrite", path.display())));
            }
            args.insert("file".into(), json!(path.display().to_string()));
            Ok(After::SaveParams { path })
        }
        "script pull" => {
            let remote = arg_str(args, "remote").unwrap_or_default().to_string();
            let name = remote.rsplit(['/', '\\']).next().unwrap_or(&remote).to_string();
            let path = absolute(arg_str(args, "local").unwrap_or(&name));
            if path.exists() && args.get("force").is_none() {
                return Err(fail("io_error", format!("{} already exists; use --force to overwrite", path.display())));
            }
            args.insert("local".into(), json!(path.display().to_string()));
            Ok(After::WriteScript { path })
        }
        "script push" => {
            if let Some(dir) = arg_str(args, "watch") {
                let path = absolute(dir);
                if !path.is_dir() {
                    return Err(fail("not_found", format!("no folder {}", path.display())));
                }
                args.insert("watch".into(), json!(path.display().to_string()));
                return Ok(After::Nothing);
            }
            let files: Vec<String> =
                args.get("files").and_then(Value::as_array).map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect()).unwrap_or_default();
            let mut sent = Vec::new();
            for file in files {
                let path = absolute(&file);
                let bytes = std::fs::read(&path).map_err(|e| {
                    if e.kind() == std::io::ErrorKind::NotFound {
                        fail("not_found", format!("no file {}", path.display()))
                    } else {
                        fail("io_error", format!("couldn't read {}: {e}", path.display()))
                    }
                })?;
                let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or(file.clone());
                sent.push(json!({"local": file, "name": name, "contentBase64": B64.encode(bytes)}));
            }
            args.insert("files".into(), Value::Array(sent));
            Ok(After::Nothing)
        }
        "logs export" => {
            let out = arg_str(args, "out").unwrap_or_default().to_string();
            let path = absolute(&out);
            if path.exists() && args.get("force").is_none() {
                return Err(fail("io_error", format!("{} already exists; use --force to overwrite", path.display())));
            }
            let jsonl = matches!(arg_str(args, "format"), Some("jsonl"));
            if let Some(format) = arg_str(args, "format") {
                if format != "csv" && format != "jsonl" {
                    return Err(fail("usage", "--format is csv or jsonl"));
                }
            }
            args.insert("out".into(), json!(path.display().to_string()));
            Ok(After::Export { path, jsonl })
        }
        _ => Ok(After::Nothing),
    }
}

/// One CSV cell: empty for null, text quoted when it holds a comma, quote or
/// line break.
fn csv_cell(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(s) if s.contains([',', '"', '\n', '\r']) => format!("\"{}\"", s.replace('"', "\"\"")),
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// Writes the files a reply carries, and swaps bulky fields in `data` for
/// what `--json` should show.
fn finish(after: &After, data: &mut Value) -> Result<(), Failure> {
    match after {
        After::Nothing => Ok(()),
        After::SaveParams { path } => {
            let params = data.get("params").and_then(Value::as_array).cloned().unwrap_or_default();
            let firmware = data.get("firmware").and_then(Value::as_str).unwrap_or("unknown firmware");
            let mut text = format!("# Aetherius GCS — {firmware} — saved by aetherius-cli\n");
            for p in &params {
                let name = p.get("name").and_then(Value::as_str).unwrap_or_default();
                let value = p.get("value").map(|v| v.to_string()).unwrap_or_default();
                text.push_str(&format!("{name},{value}\n"));
            }
            std::fs::write(path, text).map_err(|e| fail("io_error", format!("couldn't write {}: {e}", path.display())))?;
            *data = json!({"path": path.display().to_string(), "count": params.len()});
            Ok(())
        }
        After::WriteScript { path } => {
            let content = data.get("contentBase64").and_then(Value::as_str).unwrap_or_default();
            let bytes = B64.decode(content).map_err(|e| fail("io_error", format!("bad file contents from the app: {e}")))?;
            std::fs::write(path, &bytes).map_err(|e| fail("io_error", format!("couldn't write {}: {e}", path.display())))?;
            let remote = data.get("remote").cloned().unwrap_or(Value::Null);
            *data = json!({"remote": remote, "local": path.display().to_string(), "bytes": bytes.len()});
            Ok(())
        }
        After::Export { path, jsonl } => {
            let columns: Vec<String> =
                data.get("columns").and_then(Value::as_array).map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect()).unwrap_or_default();
            let rows = data.get("rows").and_then(Value::as_array).cloned().unwrap_or_default();
            let mut text = String::new();
            if *jsonl {
                for row in &rows {
                    let mut object = Map::new();
                    for (i, column) in columns.iter().enumerate() {
                        object.insert(column.clone(), row.get(i).cloned().unwrap_or(Value::Null));
                    }
                    text.push_str(&Value::Object(object).to_string());
                    text.push('\n');
                }
            } else {
                text.push_str(&columns.join(","));
                text.push('\n');
                for row in &rows {
                    let cells: Vec<String> = row.as_array().map(|r| r.iter().map(csv_cell).collect()).unwrap_or_default();
                    text.push_str(&cells.join(","));
                    text.push('\n');
                }
            }
            std::fs::write(path, text).map_err(|e| fail("io_error", format!("couldn't write {}: {e}", path.display())))?;
            *data = json!({"path": path.display().to_string(), "rows": rows.len(), "columns": columns});
            Ok(())
        }
    }
}

fn discovery() -> Result<Discovery, Failure> {
    let unavailable = || fail("app_unavailable", "Aetherius GCS isn't running, or CLI access is off (Settings › CLI)");
    let path = platform::app_data_dir().ok_or_else(unavailable)?.join(APP_IDENTIFIER).join(DISCOVERY_FILE);
    let text = std::fs::read_to_string(path).map_err(|_| unavailable())?;
    let found: Discovery = serde_json::from_str(&text).map_err(|_| unavailable())?;
    if found.protocol != PROTOCOL {
        return Err(fail(
            "version_mismatch",
            format!("the app speaks protocol {} and this CLI speaks {PROTOCOL}; update the CLI to match Aetherius GCS {}", found.protocol, found.app_version),
        ));
    }
    Ok(found)
}

fn connect(found: &Discovery) -> Result<TcpStream, Failure> {
    let address = SocketAddr::from(([127, 0, 0, 1], found.port));
    TcpStream::connect_timeout(&address, Duration::from_secs(2))
        .map_err(|_| fail("app_unavailable", "Aetherius GCS isn't running, or CLI access is off (Settings › CLI)"))
}

fn run(command: &'static CommandDef, parsed: Parsed) -> i32 {
    let mut args = parsed.args.clone();
    let after = match prepare(command, &mut args) {
        Ok(a) => a,
        Err(failure) => return print_failure(&parsed, command.name, &failure),
    };

    let found = match discovery() {
        Ok(f) => f,
        Err(failure) => return print_failure(&parsed, command.name, &failure),
    };
    let stream = match connect(&found) {
        Ok(s) => s,
        Err(failure) => return print_failure(&parsed, command.name, &failure),
    };

    let argv = std::env::args().skip(1).filter(|a| !matches!(a.as_str(), "--json" | "--quiet")).collect::<Vec<_>>().join(" ");
    let request = Request {
        protocol: PROTOCOL,
        token: found.token.clone(),
        command: command.name.to_string(),
        args,
        argv,
        cwd: cwd().display().to_string(),
        process: platform::process_chain(),
        utc_offset_minutes: platform::utc_offset_minutes(),
        timeout_secs: parsed.globals.timeout_secs,
        no_wait: parsed.globals.no_wait,
        cli_version: env!("CARGO_PKG_VERSION").to_string(),
    };

    let writer = Arc::new(Mutex::new(match stream.try_clone() {
        Ok(s) => s,
        Err(e) => return print_failure(&parsed, command.name, &fail("app_unavailable", e.to_string())),
    }));
    if send_line(&writer, &serde_json::to_string(&request).unwrap_or_default()).is_err() {
        return print_failure(&parsed, command.name, &fail("app_unavailable", "the app closed the connection"));
    }

    let streaming = command.item.is_some() && (request.args.get("follow").is_some() || request.args.get("watch").is_some());
    if streaming {
        platform::catch_ctrl_c();
        let stopper = writer.clone();
        std::thread::spawn(move || loop {
            if platform::interrupted() {
                let _ = send_line(&stopper, &serde_json::to_string(&ClientMessage::Stop).unwrap_or_default());
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        });
    }
    if let Some(dir) = request.args.get("watch").and_then(Value::as_str) {
        let dir = PathBuf::from(dir);
        let pusher = writer.clone();
        std::thread::spawn(move || watch_folder(&dir, &pusher));
    }

    read_replies(command, &parsed, stream, &after)
}

fn send_line(writer: &Arc<Mutex<TcpStream>>, line: &str) -> std::io::Result<()> {
    let mut stream = writer.lock().unwrap_or_else(|e| e.into_inner());
    stream.write_all(line.as_bytes())?;
    stream.write_all(b"\n")?;
    stream.flush()
}

fn read_replies(command: &'static CommandDef, parsed: &Parsed, stream: TcpStream, after: &After) -> i32 {
    let json_out = parsed.globals.json;
    let quiet = parsed.globals.quiet;
    let mut request_id = String::new();
    let mut was_waiting = false;

    for line in BufReader::new(stream).lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let Ok(event) = serde_json::from_str::<Event>(&line) else { continue };
        match event {
            Event::Accepted { request } => request_id = request,
            Event::State { state, reason } => {
                if quiet {
                    continue;
                }
                match state.as_str() {
                    "waiting" => {
                        was_waiting = true;
                        eprintln!("waiting for approval in Aetherius ({request_id})…");
                    }
                    "held" => eprintln!("{}…", reason.unwrap_or_else(|| "paused in Aetherius".into())),
                    "running" if was_waiting => {
                        was_waiting = false;
                        eprintln!("approved");
                    }
                    _ => {}
                }
            }
            Event::Progress { data } => {
                if !quiet {
                    if let Some(text) = format::progress(&data) {
                        eprintln!("{text}");
                    }
                }
            }
            Event::Item { data } => {
                if json_out {
                    println!("{}", json!({"request": request_id, "event": "item", "data": data}));
                } else {
                    print!("{}", format::item(command.name, &data));
                }
                let _ = std::io::stdout().flush();
            }
            Event::Pending { request } => {
                if json_out {
                    println!(
                        "{}",
                        json!({"ok": false, "request": request, "command": command.name,
                            "error": {"code": "pending", "message": format!("waiting for approval; finish with: aetherius-cli requests wait {request}")}})
                    );
                } else {
                    eprintln!("{request} is waiting for approval; finish with: aetherius-cli requests wait {request}");
                }
                return protocol::exit_code("pending");
            }
            Event::End { ok, command: reply_command, mut data, error } => {
                // `requests show/wait` reply with the original command's data.
                let shown = if reply_command.is_empty() { command.name.to_string() } else { reply_command };
                if ok {
                    if let Err(failure) = finish(after, &mut data) {
                        return print_failure(parsed, &shown, &failure);
                    }
                }
                let interrupted = platform::interrupted() && command.item.is_some();
                if json_out {
                    let mut body = json!({"ok": ok, "request": request_id, "command": shown});
                    if streaming_end(command, parsed) {
                        body["event"] = json!("end");
                    }
                    if !data.is_null() {
                        body["data"] = data.clone();
                    }
                    if let Some(e) = &error {
                        body["error"] = serde_json::to_value(e).unwrap_or(Value::Null);
                    }
                    println!("{body}");
                } else {
                    if !data.is_null() {
                        let text = format::human(&shown, &data);
                        if interrupted || streaming_end(command, parsed) {
                            eprint!("{text}");
                        } else {
                            print!("{text}");
                        }
                    }
                    if let Some(e) = &error {
                        eprintln!("error: {}: {}", e.code, e.message);
                    }
                }
                if interrupted && ok {
                    return EXIT_INTERRUPTED;
                }
                return match error {
                    Some(e) if !ok => protocol::exit_code(&e.code),
                    _ => 0,
                };
            }
        }
    }
    print_failure(parsed, command.name, &fail("app_unavailable", "the app closed the connection before replying"))
}

fn streaming_end(command: &CommandDef, parsed: &Parsed) -> bool {
    command.item.is_some() && (parsed.args.get("follow").is_some() || parsed.args.get("watch").is_some())
}

/// Every `.lua` file under `dir`, relative path → (modified time, size).
fn scan_lua(dir: &Path) -> HashMap<String, (SystemTime, u64)> {
    let mut found = HashMap::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(current) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&current) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(meta) = entry.metadata() else { continue };
            if meta.is_dir() {
                stack.push(path);
            } else if path.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("lua")) {
                if let Ok(relative) = path.strip_prefix(dir) {
                    let key = relative.to_string_lossy().replace('\\', "/");
                    found.insert(key, (meta.modified().unwrap_or(SystemTime::UNIX_EPOCH), meta.len()));
                }
            }
        }
    }
    found
}

/// `script push --watch`: pushes each `.lua` file under `dir` once it has
/// been saved and left alone for 500 ms. Files already there are only
/// remembered, not pushed.
fn watch_folder(dir: &Path, writer: &Arc<Mutex<TcpStream>>) {
    let mut known = scan_lua(dir);
    let mut changed: HashMap<String, Instant> = HashMap::new();
    loop {
        if platform::interrupted() {
            return;
        }
        std::thread::sleep(Duration::from_millis(250));
        let now = scan_lua(dir);
        for (file, stamp) in &now {
            if known.get(file) != Some(stamp) {
                changed.insert(file.clone(), Instant::now());
            }
        }
        known = now;

        let ready: Vec<String> =
            changed.iter().filter(|(_, at)| at.elapsed() >= Duration::from_millis(500)).map(|(f, _)| f.clone()).collect();
        for file in ready {
            changed.remove(&file);
            let Ok(bytes) = std::fs::read(dir.join(&file)) else { continue };
            let message = ClientMessage::Push { file: file.clone(), content_base64: B64.encode(bytes) };
            if send_line(writer, &serde_json::to_string(&message).unwrap_or_default()).is_err() {
                return;
            }
        }
    }
}
