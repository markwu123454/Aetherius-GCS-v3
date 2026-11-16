//! Human-readable output for each command's reply `data`. `--json` skips
//! all of this and prints the data as it came.

use serde_json::Value;

fn s(v: &Value) -> String {
    match v {
        Value::String(text) => text.clone(),
        Value::Null => "—".to_string(),
        Value::Number(_) => num(v),
        Value::Bool(b) => if *b { "yes" } else { "no" }.to_string(),
        other => other.to_string(),
    }
}

/// A number as JSON gave it for integers and parameter values (already the
/// shortest exact form), otherwise trimmed to three decimals.
pub fn num(v: &Value) -> String {
    match v {
        Value::Number(n) if n.is_i64() || n.is_u64() => n.to_string(),
        Value::Number(n) => {
            let f = n.as_f64().unwrap_or(f64::NAN);
            fixed(f, 3)
        }
        other => s(other),
    }
}

pub fn fixed(f: f64, decimals: usize) -> String {
    if !f.is_finite() {
        return "—".to_string();
    }
    let text = format!("{f:.decimals$}");
    if text.contains('.') {
        let trimmed = text.trim_end_matches('0').trim_end_matches('.');
        if trimmed == "-0" { "0".to_string() } else { trimmed.to_string() }
    } else {
        text
    }
}

/// Parameter values: shortest exact form, the way JSON carried them.
fn pval(v: &Value) -> String {
    match v {
        Value::Number(n) => n.to_string(),
        other => s(other),
    }
}

pub fn thousands(n: u64) -> String {
    let digits = n.to_string();
    let mut out = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    out
}

pub fn size(bytes: u64) -> String {
    if bytes < 1024 {
        format!("{bytes} B")
    } else if bytes < 1024 * 1024 {
        format!("{:.1} KB", bytes as f64 / 1024.0)
    } else {
        format!("{:.1} MB", bytes as f64 / (1024.0 * 1024.0))
    }
}

/// Log seconds as `m:ss.s`.
fn log_time(secs: f64) -> String {
    if !secs.is_finite() {
        return "—".to_string();
    }
    let minutes = (secs / 60.0).floor();
    format!("{}:{:04.1}", minutes as i64, secs - minutes * 60.0)
}

/// Log seconds as `m:ss`.
fn log_time_short(secs: f64) -> String {
    let total = secs.max(0.0).round() as i64;
    format!("{}:{:02}", total / 60, total % 60)
}

fn f(v: &Value, key: &str) -> f64 {
    v.get(key).and_then(Value::as_f64).unwrap_or(f64::NAN)
}

fn u(v: &Value, key: &str) -> u64 {
    v.get(key).and_then(Value::as_u64).unwrap_or(0)
}

fn st<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}

fn arr<'a>(v: &'a Value, key: &str) -> &'a [Value] {
    v.get(key).and_then(Value::as_array).map(|a| a.as_slice()).unwrap_or(&[])
}

/// Left-aligned columns separated by three spaces; columns listed in
/// `right` are right-aligned (numbers).
fn table(headers: Option<&[&str]>, rows: &[Vec<String>], right: &[usize]) -> String {
    let columns = headers.map(|h| h.len()).unwrap_or_else(|| rows.first().map(|r| r.len()).unwrap_or(0));
    let mut widths = vec![0usize; columns];
    if let Some(h) = headers {
        for (i, cell) in h.iter().enumerate() {
            widths[i] = widths[i].max(cell.chars().count());
        }
    }
    for row in rows {
        for (i, cell) in row.iter().enumerate().take(columns) {
            widths[i] = widths[i].max(cell.chars().count());
        }
    }
    let mut out = String::new();
    let mut line = |cells: Vec<String>| {
        let mut text = String::new();
        for (i, cell) in cells.iter().enumerate() {
            let pad = widths[i].saturating_sub(cell.chars().count());
            if i > 0 {
                text.push_str("   ");
            }
            if right.contains(&i) {
                text.push_str(&" ".repeat(pad));
                text.push_str(cell);
            } else {
                text.push_str(cell);
                if i + 1 < cells.len() {
                    text.push_str(&" ".repeat(pad));
                }
            }
        }
        out.push_str(text.trim_end());
        out.push('\n');
    };
    if let Some(h) = headers {
        line(h.iter().map(|c| c.to_string()).collect());
    }
    for row in rows {
        line(row.clone());
    }
    out
}

fn kv(rows: &[(&str, String)]) -> String {
    let width = rows.iter().map(|(k, _)| k.len()).max().unwrap_or(0) + 4;
    rows.iter().filter(|(_, v)| !v.is_empty()).map(|(k, v)| format!("{k:<width$}{v}\n")).collect()
}

fn wrap(text: &str, width: usize) -> String {
    let mut out = String::new();
    let mut line = String::new();
    for word in text.split_whitespace() {
        if !line.is_empty() && line.len() + 1 + word.len() > width {
            out.push_str(&line);
            out.push('\n');
            line.clear();
        }
        if !line.is_empty() {
            line.push(' ');
        }
        line.push_str(word);
    }
    if !line.is_empty() {
        out.push_str(&line);
        out.push('\n');
    }
    out
}

fn restart_lines(data: &Value) -> String {
    let mut out = String::new();
    if data.get("restarted").and_then(Value::as_bool) == Some(true) {
        out.push_str("scripting restarted\n");
        let errors = arr(data, "luaErrors");
        if errors.is_empty() {
            out.push_str("no Lua errors\n");
        }
        for e in errors {
            out.push_str(&s(e));
            out.push('\n');
        }
    } else if data.get("rebootNeeded").and_then(Value::as_bool) == Some(true) {
        out.push_str("scripting not restarted: reboot to load\n");
    } else {
        out.push_str("scripting not restarted\n");
    }
    out
}

/// ` · N not on vehicle (A, B)` for the names a `params get/describe` didn't
/// find, or nothing.
fn not_on_vehicle(data: &Value) -> String {
    let missing = arr(data, "missing");
    if missing.is_empty() {
        return String::new();
    }
    format!(" · {} not on vehicle ({})", missing.len(), missing.iter().map(s).collect::<Vec<_>>().join(", "))
}

fn changes(data: &Value) -> String {
    let rows: Vec<Vec<String>> = arr(data, "changes")
        .iter()
        .map(|c| {
            let status = if data.get("dryRun").and_then(Value::as_bool) == Some(true) {
                String::new()
            } else if c.get("confirmed").and_then(Value::as_bool) == Some(true) {
                String::new()
            } else {
                c.get("error").and_then(Value::as_str).map(|e| format!("not confirmed: {e}")).unwrap_or_else(|| "not confirmed".into())
            };
            vec![st(c, "name").to_string(), pval(&c["from"]), "→".to_string(), pval(&c["to"]), status]
        })
        .collect();
    let mut out = table(None, &rows, &[1]);
    let unchanged = arr(data, "unchanged");
    if !unchanged.is_empty() {
        out.push_str(&format!("unchanged: {}\n", unchanged.iter().map(s).collect::<Vec<_>>().join(", ")));
    }
    let skipped = arr(data, "skipped");
    if !skipped.is_empty() {
        out.push_str(&format!("not on vehicle: {}\n", skipped.iter().map(s).collect::<Vec<_>>().join(", ")));
    }
    if data.get("dryRun").and_then(Value::as_bool) == Some(true) {
        out.push_str("dry run, nothing sent\n");
    } else if !arr(data, "changes").is_empty() {
        out.push_str(&format!("applied {} of {}\n", u(data, "applied"), u(data, "total")));
    } else {
        out.push_str("nothing to change\n");
    }
    if data.get("rebootNeeded").and_then(Value::as_bool) == Some(true) {
        out.push_str("reboot needed\n");
    }
    out
}

fn stats(data: &Value) -> String {
    let rows: Vec<Vec<String>> = arr(data, "fields")
        .iter()
        .map(|r| {
            vec![
                st(r, "field").to_string(),
                thousands(u(r, "n")),
                fixed(f(r, "min"), 3),
                fixed(f(r, "max"), 3),
                fixed(f(r, "mean"), 3),
                fixed(f(r, "rms"), 3),
                fixed(f(r, "p95"), 3),
            ]
        })
        .collect();
    table(Some(&["field", "n", "min", "max", "mean", "rms", "p95"]), &rows, &[1, 2, 3, 4, 5, 6])
}

fn series(data: &Value) -> String {
    let columns: Vec<String> = arr(data, "columns").iter().map(s).collect();
    let headers: Vec<&str> = columns.iter().map(String::as_str).collect();
    let rows: Vec<Vec<String>> = arr(data, "rows")
        .iter()
        .map(|row| {
            row.as_array()
                .map(|cells| {
                    cells
                        .iter()
                        .enumerate()
                        .map(|(i, c)| if i == 0 { log_time(c.as_f64().unwrap_or(f64::NAN)) } else { fixed(c.as_f64().unwrap_or(f64::NAN), 3) })
                        .collect()
                })
                .unwrap_or_default()
        })
        .collect();
    let right: Vec<usize> = (0..headers.len()).collect();
    let mut out = table(Some(&headers), &rows, &right);
    let samples = u(data, "samples");
    if data.get("averaged").and_then(Value::as_bool) == Some(true) {
        out.push_str(&format!("{} rows · averaged from {} samples\n", rows.len(), thousands(samples)));
    } else {
        out.push_str(&format!("{} rows\n", rows.len()));
    }
    out
}

fn fft(data: &Value) -> String {
    let mut out = format!(
        "sample rate {} Hz · resolution {} Hz · {} s\n",
        fixed(f(data, "sampleRate"), 1),
        fixed(f(data, "resolution"), 2),
        fixed(f(data, "seconds"), 0)
    );
    let fields = arr(data, "fields");
    let peaks = fields.iter().map(|r| arr(r, "peaks").len()).max().unwrap_or(0);
    let mut headers = vec!["field".to_string()];
    for i in 0..peaks {
        headers.push(format!("peak {}", i + 1));
    }
    let rows: Vec<Vec<String>> = fields
        .iter()
        .map(|r| {
            let mut row = vec![st(r, "field").to_string()];
            for i in 0..peaks {
                row.push(
                    arr(r, "peaks")
                        .get(i)
                        .map(|p| format!("{} Hz  {} dB", fixed(f(p, "hz"), if f(data, "resolution") < 1.0 { 1 } else { 0 }), fixed(f(p, "db"), 0)))
                        .unwrap_or_else(|| "—".into()),
                );
            }
            row
        })
        .collect();
    let header_refs: Vec<&str> = headers.iter().map(String::as_str).collect();
    out.push_str(&table(Some(&header_refs), &rows, &[]));
    for r in fields {
        let bins = arr(r, "bins");
        if !bins.is_empty() {
            out.push_str(&format!("\n{} spectrum\n", st(r, "field")));
            let rows: Vec<Vec<String>> =
                bins.iter().map(|b| vec![format!("{} Hz", fixed(f(b, "hz"), 1)), format!("{} dB", fixed(f(b, "db"), 1))]).collect();
            out.push_str(&table(None, &rows, &[0, 1]));
        }
    }
    out
}

/// Human output for a finished command. `None` for commands whose output
/// the caller prints itself.
pub fn human(command: &str, data: &Value) -> String {
    match command {
        "status" => {
            let link = match data.get("link") {
                Some(Value::Object(l)) => {
                    let endpoint = l.get("endpoint").map(s).unwrap_or_default();
                    match l.get("board").and_then(Value::as_str) {
                        Some(board) => format!("{endpoint} · {board}"),
                        None => endpoint,
                    }
                }
                _ => "none".to_string(),
            };
            let mut rows = vec![("link", link)];
            if data.get("link").is_some_and(|l| !l.is_null()) {
                rows.push(("firmware", data.get("firmware").map(s).unwrap_or_default()));
                let armed = match data.get("armed").and_then(Value::as_bool) {
                    Some(true) => "armed",
                    Some(false) => "disarmed",
                    None => "—",
                };
                rows.push(("state", format!("{armed} · {}", data.get("mode").map(s).unwrap_or_else(|| "—".into()))));
                let params = &data["params"];
                let loaded = u(params, "loaded");
                rows.push((
                    "params",
                    match params.get("total").and_then(Value::as_u64) {
                        Some(total) if total > loaded => format!("{loaded} of {total} loaded"),
                        _ => format!("{loaded} loaded"),
                    },
                ));
            }
            let p = &data["permissions"];
            rows.push((
                "cli",
                format!(
                    "reads {} · logs {} · params {} · scripts {} · reboot {} · while armed {}",
                    st(p, "reads"),
                    st(p, "logs"),
                    st(p, "params"),
                    st(p, "scripts"),
                    st(p, "reboot"),
                    st(p, "whileArmed")
                ),
            ));
            kv(&rows)
        }
        "params get" => {
            let params = arr(data, "params");
            let rows: Vec<Vec<String>> = params
                .iter()
                .map(|p| vec![st(p, "name").to_string(), pval(&p["value"]), p.get("units").and_then(Value::as_str).unwrap_or("").to_string()])
                .collect();
            let mut out = table(None, &rows, &[]);
            out.push_str(&format!("{} parameter{}{}\n", params.len(), if params.len() == 1 { "" } else { "s" }, not_on_vehicle(data)));
            out
        }
        "params describe" => {
            let mut out = String::new();
            for (i, p) in arr(data, "params").iter().enumerate() {
                if i > 0 {
                    out.push('\n');
                }
                let units = p.get("units").and_then(Value::as_str).map(|u| format!(" {u}")).unwrap_or_default();
                let mut rows = vec![(st(p, "name"), st(p, "humanName").to_string())];
                rows.push(("value", format!("{}{units}", pval(&p["value"]))));
                if let Some(range) = p.get("range").and_then(Value::as_array) {
                    if range.len() == 2 {
                        rows.push(("range", format!("{} – {}{units}", pval(&range[0]), pval(&range[1]))));
                    }
                }
                if let Some(inc) = p.get("increment").filter(|v| !v.is_null()) {
                    rows.push(("increment", pval(inc)));
                }
                rows.push(("level", st(p, "level").to_string()));
                if p.get("rebootRequired").and_then(Value::as_bool) == Some(true) {
                    rows.push(("reboot", "needed after a change".to_string()));
                }
                if let Some(values) = p.get("values").and_then(Value::as_array) {
                    rows.push(("values", values.iter().map(|v| format!("{} {}", pval(&v["value"]), st(v, "label"))).collect::<Vec<_>>().join(" · ")));
                }
                let width = rows.iter().map(|(k, _)| k.len()).max().unwrap_or(0).max(12) + 3;
                for (k, v) in &rows {
                    if !v.is_empty() {
                        out.push_str(&format!("{k:<width$}{v}\n"));
                    }
                }
                if let Some(bits) = p.get("bitmask").and_then(Value::as_array) {
                    out.push_str("bits\n");
                    for b in bits {
                        let mark = if b.get("set").and_then(Value::as_bool) == Some(true) { "[x]" } else { "[ ]" };
                        out.push_str(&format!("  {mark} {:>2}  {}\n", u(b, "bit"), st(b, "label")));
                    }
                }
                let description = st(p, "description");
                if !description.is_empty() {
                    out.push('\n');
                    out.push_str(&wrap(description, 78));
                }
            }
            let missing = not_on_vehicle(data);
            if !missing.is_empty() {
                out.push_str(&format!("\n{}\n", missing.trim_start_matches(" · ")));
            }
            out
        }
        "params set" | "params apply" => changes(data),
        "params diff" => {
            let differ = arr(data, "differ");
            let rows: Vec<Vec<String>> =
                differ.iter().map(|d| vec![st(d, "name").to_string(), pval(&d["live"]), "→".into(), pval(&d["file"])]).collect();
            let mut out = table(None, &rows, &[1]);
            let missing = arr(data, "missing");
            let mut summary = format!("{} differ · {} same", differ.len(), u(data, "same"));
            if !missing.is_empty() {
                summary.push_str(&format!(
                    " · {} not on vehicle ({})",
                    missing.len(),
                    missing.iter().map(s).collect::<Vec<_>>().join(", ")
                ));
            }
            out.push_str(&summary);
            out.push('\n');
            out
        }
        "params save" => format!("saved {} parameters to {}\n", u(data, "count"), st(data, "path")),
        "params refresh" => format!("{} parameters loaded\n", u(data, "loaded")),
        "script ls" => {
            let rows: Vec<Vec<String>> = arr(data, "entries")
                .iter()
                .map(|e| {
                    if e.get("dir").and_then(Value::as_bool) == Some(true) {
                        vec![format!("{}/", st(e, "name")), String::new()]
                    } else {
                        vec![st(e, "name").to_string(), e.get("bytes").and_then(Value::as_u64).map(size).unwrap_or_default()]
                    }
                })
                .collect();
            if rows.is_empty() {
                format!("{} is empty\n", st(data, "dir"))
            } else {
                table(None, &rows, &[1])
            }
        }
        "script pull" => format!("pulled {} → {} ({})\n", st(data, "remote"), st(data, "local"), size(u(data, "bytes"))),
        "script push" => {
            if data.get("pushed").is_some_and(|v| !v.is_null()) {
                return format!("stopped · {} pushed · {} held\n", u(data, "pushed"), u(data, "held"));
            }
            let mut out = String::new();
            for file in arr(data, "files") {
                let new = if file.get("new").and_then(Value::as_bool) == Some(true) { ", new" } else { "" };
                out.push_str(&format!("uploaded {} → {} ({}{new})\n", st(file, "local"), st(file, "remote"), size(u(file, "bytes"))));
            }
            out.push_str(&restart_lines(data));
            out
        }
        "script rm" => format!("removed {}\n{}", st(data, "removed"), restart_lines(data)),
        "script restart" => restart_lines(data),
        "console" => arr(data, "messages").iter().map(console_line).collect(),
        "logs ls" => {
            let rows: Vec<Vec<String>> = arr(data, "logs")
                .iter()
                .map(|l| {
                    vec![
                        u(l, "id").to_string(),
                        l.get("time").and_then(Value::as_str).map(|t| t.replace('T', " ").chars().take(16).collect()).unwrap_or_else(|| "unknown".into()),
                        size(u(l, "bytes")),
                    ]
                })
                .collect();
            if rows.is_empty() {
                "no logs on the vehicle\n".to_string()
            } else {
                table(Some(&["id", "date", "size"]), &rows, &[0, 2])
            }
        }
        "logs pull" => {
            let mut out = if data.get("alreadySaved").and_then(Value::as_bool) == Some(true) {
                format!("log {} already downloaded → {}\n", u(data, "id"), st(data, "file"))
            } else {
                format!(
                    "pulled log {} → {} ({}, {} s)\n",
                    u(data, "id"),
                    st(data, "file"),
                    size(u(data, "bytes")),
                    fixed(f(data, "seconds"), 1)
                )
            };
            if let Some(earlier) = data.get("earlier").and_then(Value::as_str) {
                out.push_str(&format!("saved as {}, {earlier} is an earlier log\n", st(data, "file")));
            }
            out
        }
        "logs local" => {
            let rows: Vec<Vec<String>> = arr(data, "logs")
                .iter()
                .map(|l| {
                    vec![
                        u(l, "id").to_string(),
                        st(l, "file").to_string(),
                        size(u(l, "bytes")),
                        st(l, "downloaded").replace('T', " ").chars().take(16).collect(),
                        match l.get("onVehicle").and_then(Value::as_bool) {
                            Some(true) => "yes".into(),
                            _ => String::new(),
                        },
                    ]
                })
                .collect();
            if rows.is_empty() {
                "no downloaded logs for this vehicle\n".to_string()
            } else {
                table(Some(&["id", "file", "size", "downloaded", "on vehicle"]), &rows, &[0, 2])
            }
        }
        "logs info" => kv(&[
            ("file", format!("{} · {}", st(data, "file"), size(u(data, "bytes")))),
            ("firmware", data.get("firmware").and_then(Value::as_str).unwrap_or("").to_string()),
            ("start", data.get("start").and_then(Value::as_str).map(|t| t.replace('T', " ")).unwrap_or_default()),
            ("duration", log_time_short(f(data, "duration"))),
            ("messages", format!("{} types · {} records", u(data, "types"), thousands(u(data, "records")))),
        ]),
        "logs schema" => {
            let messages = arr(data, "messages");
            if messages.len() == 1 {
                let m = &messages[0];
                let mut out = format!("{}   {} Hz   {} records\n", st(m, "name"), fixed(f(m, "rate"), 1), thousands(u(m, "count")));
                let rows: Vec<Vec<String>> = arr(m, "fields")
                    .iter()
                    .map(|fl| vec![st(fl, "name").to_string(), fl.get("unit").and_then(Value::as_str).unwrap_or("").to_string()])
                    .collect();
                out.push_str(&table(Some(&["field", "unit"]), &rows, &[]));
                out
            } else {
                let rows: Vec<Vec<String>> = messages
                    .iter()
                    .map(|m| {
                        vec![
                            st(m, "name").to_string(),
                            format!("{} Hz", fixed(f(m, "rate"), 1)),
                            arr(m, "fields").iter().map(|fl| st(fl, "name").to_string()).collect::<Vec<_>>().join(" "),
                        ]
                    })
                    .collect();
                table(None, &rows, &[1])
            }
        }
        "logs series" => series(data),
        "logs events" => {
            let rows: Vec<Vec<String>> = arr(data, "events")
                .iter()
                .map(|e| vec![log_time(f(e, "t")), st(e, "type").to_string(), st(e, "text").to_string()])
                .collect();
            if rows.is_empty() {
                "no events\n".to_string()
            } else {
                table(None, &rows, &[0])
            }
        }
        "logs segments" => {
            let rows: Vec<Vec<String>> = arr(data, "segments")
                .iter()
                .map(|seg| {
                    vec![
                        st(seg, "mode").to_string(),
                        log_time_short(f(seg, "from")),
                        log_time_short(f(seg, "to")),
                        if seg.get("armed").and_then(Value::as_bool) == Some(true) { "yes".into() } else { "no".into() },
                    ]
                })
                .collect();
            let mut out = table(Some(&["mode", "from", "to", "armed"]), &rows, &[1, 2]);
            for a in arr(data, "armed") {
                out.push_str(&format!("armed {} – {}\n", log_time_short(f(a, "from")), log_time_short(f(a, "to"))));
            }
            out
        }
        "logs stats" => stats(data),
        "logs fft" => fft(data),
        "logs track-error" => {
            let units = data.get("units").and_then(Value::as_str).map(|u| format!(" {u}")).unwrap_or_default();
            format!(
                "rms {}{units} · max {}{units} · mean {}{units} · lag {} ms · {} samples\n",
                fixed(f(data, "rms"), 2),
                fixed(f(data, "max"), 2),
                fixed(f(data, "mean"), 2),
                fixed(f(data, "lagMs"), 0),
                thousands(u(data, "samples"))
            )
        }
        "logs eval" => {
            if data.get("sampleRate").is_some() {
                fft(data)
            } else if data.get("columns").is_some() {
                series(data)
            } else {
                stats(data)
            }
        }
        "logs export" => format!("exported {} rows → {}\n", thousands(u(data, "rows")), st(data, "path")),
        "reboot" => {
            if data.get("reconnected").and_then(Value::as_bool) == Some(true) {
                format!(
                    "link back after {} s · {} parameters loaded\n",
                    fixed(f(data, "seconds"), 1),
                    data.get("params").and_then(Value::as_u64).unwrap_or(0)
                )
            } else {
                "rebooting\n".to_string()
            }
        }
        "requests ls" => {
            let rows: Vec<Vec<String>> = arr(data, "requests")
                .iter()
                .map(|r| vec![st(r, "id").to_string(), st(r, "time").to_string(), st(r, "state").to_string(), st(r, "command").to_string()])
                .collect();
            if rows.is_empty() {
                "no requests\n".to_string()
            } else {
                table(Some(&["id", "time", "state", "command"]), &rows, &[])
            }
        }
        "requests stop" => format!("stopped {}\n", st(data, "stopped")),
        _ => {
            if data.is_null() {
                String::new()
            } else {
                serde_json::to_string_pretty(data).unwrap_or_default() + "\n"
            }
        }
    }
}

pub fn console_line(m: &Value) -> String {
    format!("{}  {:<9} {}\n", st(m, "time"), st(m, "severity"), st(m, "text"))
}

/// One streamed item.
pub fn item(command: &str, data: &Value) -> String {
    match command {
        "console" => console_line(data),
        "script push" => {
            let mut line = format!("{}  {:<16} {}", st(data, "time"), st(data, "file"), st(data, "result"));
            if let Some(reason) = data.get("reason").and_then(Value::as_str) {
                line.push_str(&format!(": {reason}"));
            }
            for e in arr(data, "luaErrors") {
                line.push_str(&format!("\n          {}", s(e)));
            }
            line + "\n"
        }
        _ => serde_json::to_string(data).unwrap_or_default() + "\n",
    }
}

/// A progress event's line for stderr.
pub fn progress(data: &Value) -> Option<String> {
    data.get("text").and_then(Value::as_str).map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn numbers() {
        assert_eq!(fixed(7.2, 3), "7.2");
        assert_eq!(fixed(-0.0001, 3), "0");
        assert_eq!(thousands(113950), "113,950");
        assert_eq!(size(40055603), "38.2 MB");
        assert_eq!(log_time(130.0), "2:10.0");
        assert_eq!(pval(&json!(0.135)), "0.135");
    }

    #[test]
    fn change_table() {
        let data = json!({"changes": [{"name": "A", "from": 80, "to": 160, "confirmed": true}], "unchanged": [], "skipped": [], "applied": 1, "total": 1, "rebootNeeded": false, "dryRun": false});
        let out = human("params set", &data);
        assert!(out.contains("A   80   →   160"), "{out}");
        assert!(out.contains("applied 1 of 1"));
    }
}
