//! The TCP listener: one thread accepting on 127.0.0.1, one thread per
//! connection. Each connection is one request (see `protocol.rs` in the
//! `aetherius-cli` crate for the line format).

use std::{
    hash::{BuildHasher, Hasher},
    io::{BufRead, BufReader, Write},
    net::{TcpListener, TcpStream},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use aetherius_cli::{
    catalog,
    protocol::{ClientMessage, Discovery, ErrorBody, Event, Request, DISCOVERY_FILE, PROTOCOL},
};
use tauri::{AppHandle, Manager};

use super::{ctx::Ctx, handlers, requests::NewRecord, CliState};

pub struct ServerHandle {
    stop: Arc<AtomicBool>,
    port: u16,
}

impl ServerHandle {
    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn stop(self, app: &AppHandle) {
        self.stop.store(true, Ordering::SeqCst);
        if let Ok(dir) = app.path().app_data_dir() {
            let _ = std::fs::remove_file(dir.join(DISCOVERY_FILE));
        }
    }
}

/// 128 bits from SipHash under the process's random keys — not a CSPRNG,
/// but unpredictable to anything that can't already read this process's
/// memory, which is all a token on 127.0.0.1 needs.
fn new_token() -> String {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0) as u64;
    (0..2u64)
        .map(|i| {
            let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
            hasher.write_u64(nanos ^ i.rotate_left(17));
            hasher.write_u32(std::process::id());
            format!("{:016x}", hasher.finish())
        })
        .collect()
}

pub fn start(app: &AppHandle) -> Result<ServerHandle, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|e| format!("couldn't start the CLI server: {e}"))?;
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let token = new_token();

    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let discovery = Discovery {
        port,
        token: token.clone(),
        pid: std::process::id(),
        app_version: app.package_info().version.to_string(),
        protocol: PROTOCOL,
    };
    std::fs::write(dir.join(DISCOVERY_FILE), serde_json::to_string_pretty(&discovery).unwrap_or_default())
        .map_err(|e| format!("couldn't write {DISCOVERY_FILE}: {e}"))?;

    let stop = Arc::new(AtomicBool::new(false));
    let stop_flag = stop.clone();
    let handle = app.clone();
    std::thread::spawn(move || {
        while !stop_flag.load(Ordering::SeqCst) {
            match listener.accept() {
                Ok((stream, _)) => {
                    let app = handle.clone();
                    let token = token.clone();
                    std::thread::spawn(move || serve(app, stream, &token));
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(50)),
                Err(_) => std::thread::sleep(Duration::from_millis(200)),
            }
        }
    });

    Ok(ServerHandle { stop, port })
}

fn reply_error(mut stream: &TcpStream, command: &str, code: &str, message: &str) {
    let event = Event::End {
        ok: false,
        command: command.to_string(),
        data: serde_json::Value::Null,
        error: Some(ErrorBody { code: code.to_string(), message: message.to_string(), reason: None }),
    };
    let _ = writeln!(stream, "{}", serde_json::to_string(&event).unwrap_or_default());
}

fn serve(app: AppHandle, stream: TcpStream, token: &str) {
    let _ = stream.set_nonblocking(false);
    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
    let Ok(writer) = stream.try_clone() else { return };
    let mut reader = BufReader::new(stream);

    let mut first = String::new();
    if reader.read_line(&mut first).is_err() || first.trim().is_empty() {
        return;
    }
    let request: Request = match serde_json::from_str(&first) {
        Ok(r) => r,
        Err(e) => return reply_error(&writer, "", "usage", &format!("couldn't read the request: {e}")),
    };
    if request.protocol != PROTOCOL {
        return reply_error(
            &writer,
            &request.command,
            "version_mismatch",
            &format!("this app speaks protocol {PROTOCOL}, the CLI speaks {}; update the CLI", request.protocol),
        );
    }
    if request.token != token {
        return reply_error(&writer, &request.command, "app_unavailable", "the token doesn't match this app; is another Aetherius running?");
    }
    let Some(def) = catalog::find(&request.command).filter(|d| !d.local) else {
        return reply_error(&writer, &request.command, "usage", &format!("unknown command {}", request.command));
    };

    let state = app.state::<CliState>();
    let id = state.registry.create(
        &app,
        NewRecord {
            command: def.name.to_string(),
            argv: request.argv.clone(),
            folder: request.cwd.clone(),
            process: request.process.clone(),
            category: def.category.key().to_string(),
            utc_offset_minutes: request.utc_offset_minutes,
        },
    );

    let gone = Arc::new(AtomicBool::new(false));
    let (tx, rx) = mpsc::channel();
    let _ = reader.get_ref().set_read_timeout(None);
    {
        let gone = gone.clone();
        std::thread::spawn(move || {
            for line in reader.lines() {
                let Ok(line) = line else { break };
                if let Ok(message) = serde_json::from_str::<ClientMessage>(&line) {
                    if tx.send(message).is_err() {
                        break;
                    }
                }
            }
            gone.store(true, Ordering::SeqCst);
        });
    }

    let ctx = Ctx::new(app.clone(), id.clone(), def, request, writer, rx, gone);
    ctx.send(&Event::Accepted { request: id });
    let outcome = tauri::async_runtime::block_on(handlers::run(&ctx));
    ctx.finish(outcome);
}
