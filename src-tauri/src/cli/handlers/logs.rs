//! `logs ls / pull / local` and the analysis commands.

use std::{
    path::PathBuf,
    sync::Mutex,
    time::{Instant, UNIX_EPOCH},
};

use serde_json::{json, Value};

use super::{analysis as a, expr, plain};
use crate::cli::ctx::{vehicle_error, CliError, CliResult, Ctx};

/// The FAT filesystem's default timestamp plus a day: anything earlier means
/// the board never had a real clock when it wrote the log.
const FAT_EPOCH_GRACE: u32 = 315_532_800 + 86_400;

fn mb(bytes: u64) -> String {
    format!("{:.1} MB", bytes as f64 / (1024.0 * 1024.0))
}

pub async fn ls(ctx: &Ctx) -> CliResult {
    ctx.authorize(plain()).await?;
    let entries = crate::logs::list_logs(ctx.app.clone()).await.map_err(vehicle_error)?;
    let logs: Vec<Value> = entries
        .iter()
        .map(|e| {
            let time = (e.time_utc >= FAT_EPOCH_GRACE).then(|| ctx.iso(e.time_utc as u64 * 1000));
            json!({"id": e.id, "time": time, "bytes": e.size})
        })
        .collect();
    Ok(json!({"logs": logs}))
}

pub async fn pull(ctx: &Ctx) -> CliResult {
    let wanted = ctx.str("id").unwrap_or_default().to_string();
    let entries = crate::logs::list_logs(ctx.app.clone()).await.map_err(vehicle_error)?;
    let entry = if wanted.eq_ignore_ascii_case("latest") {
        entries.iter().max_by_key(|e| e.id)
    } else {
        let id: u16 = wanted.parse().map_err(|_| CliError::new("usage", format!("{wanted} isn't a log number or latest")))?;
        entries.iter().find(|e| e.id == id)
    }
    .cloned()
    .ok_or_else(|| CliError::new("not_found", format!("the vehicle has no log {wanted}")))?;

    ctx.authorize(json!({"kind": "logPull", "id": entry.id, "bytes": entry.size})).await?;
    let started = Instant::now();
    let last = Mutex::new(Instant::now() - std::time::Duration::from_secs(5));
    let report = |received: u32, total: u32| {
        if ctx.stop_requested() {
            crate::logs::cancel_download(ctx.app.clone(), entry.id);
        }
        let mut last = last.lock().unwrap_or_else(|e| e.into_inner());
        if last.elapsed().as_millis() >= 1000 || received >= total {
            *last = Instant::now();
            ctx.progress(json!({"text": format!("{} / {}", mb(received as u64), mb(total as u64)), "received": received, "total": total}));
        }
    };
    let (path, already_saved) = crate::logs::download(&ctx.app, entry.id, entry.size, &report).await.map_err(|e| {
        if e == "cancelled" {
            CliError::new("stopped", "stopped in the app")
        } else {
            vehicle_error(e)
        }
    })?;
    let file = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let first = format!("{:08}.bin", entry.id);
    let bytes = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(entry.size as u64);
    Ok(json!({
        "id": entry.id,
        "file": file,
        "path": path.to_string_lossy(),
        "bytes": bytes,
        "seconds": (started.elapsed().as_secs_f64() * 10.0).round() / 10.0,
        "alreadySaved": already_saved,
        "earlier": (file != first).then_some(first),
    }))
}

fn modified_ms(path: &PathBuf) -> u64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub async fn local(ctx: &Ctx) -> CliResult {
    ctx.authorize(plain()).await?;
    let downloaded = crate::logs::list_downloaded_logs(ctx.app.clone()).map_err(vehicle_error)?;
    let on_vehicle = crate::logs::cached_entries(&ctx.app);
    let mut rows: Vec<(u64, Value)> = downloaded
        .iter()
        .map(|d| {
            let path = PathBuf::from(&d.path);
            let at = modified_ms(&path);
            let matched = (!on_vehicle.is_empty()).then(|| on_vehicle.iter().any(|e| e.id == d.id && e.size as u64 == d.size));
            (
                at,
                json!({
                    "id": d.id,
                    "file": path.file_name().map(|n| n.to_string_lossy().to_string()),
                    "path": d.path,
                    "bytes": d.size,
                    "downloaded": ctx.iso(at),
                    "onVehicle": matched,
                }),
            )
        })
        .collect();
    rows.sort_by_key(|(at, _)| *at);
    Ok(json!({"logs": rows.into_iter().map(|(_, v)| v).collect::<Vec<_>>()}))
}

/// Finds the file a `LOG` argument means: a log number (the downloaded
/// copy matching what the vehicle has under it), `latest`, a file name in
/// the vehicle's log folder, or a path.
async fn resolve(ctx: &Ctx, raw: &str) -> CliResult<PathBuf> {
    let dir = crate::logs::logs_dir(&ctx.app).ok();
    let downloaded = crate::logs::list_downloaded_logs(ctx.app.clone()).unwrap_or_default();

    if raw.eq_ignore_ascii_case("latest") {
        return downloaded
            .iter()
            .map(|d| PathBuf::from(&d.path))
            .max_by_key(modified_ms)
            .ok_or_else(|| CliError::new("not_found", "no downloaded logs for this vehicle (aetherius-cli logs pull latest)"));
    }

    if let Ok(id) = raw.parse::<u16>() {
        let copies: Vec<&crate::logs::DownloadedLog> = downloaded.iter().filter(|d| d.id == id).collect();
        let mut entries = crate::logs::cached_entries(&ctx.app);
        if entries.is_empty() && ctx.vehicle_ready().is_ok() {
            entries = crate::logs::list_logs(ctx.app.clone()).await.unwrap_or_default();
        }
        if let Some(entry) = entries.iter().find(|e| e.id == id) {
            return copies
                .iter()
                .find(|d| d.size == entry.size as u64)
                .map(|d| PathBuf::from(&d.path))
                .ok_or_else(|| CliError::new("not_found", format!("log {id} isn't downloaded (aetherius-cli logs pull {id})")));
        }
        return match copies.as_slice() {
            [only] => Ok(PathBuf::from(&only.path)),
            [] => Err(CliError::new("not_found", format!("no downloaded log {id} for this vehicle"))),
            _ => Err(CliError::new(
                "not_found",
                format!("several logs were saved as {id}; pass the file name from aetherius-cli logs local"),
            )),
        };
    }

    if let Some(dir) = dir {
        let candidate = dir.join(raw);
        if !raw.contains(['/', '\\']) && candidate.is_file() {
            return Ok(candidate);
        }
    }
    let path = ctx.path(raw);
    if path.is_file() {
        return Ok(path);
    }
    Err(CliError::new("not_found", format!("no log {raw}")))
}

fn usage(e: String) -> CliError {
    CliError::new("usage", e)
}

fn not_enough(e: String) -> CliError {
    CliError::new("not_enough_data", e)
}

fn range(ctx: &Ctx, log: &a::Log) -> CliResult<a::Range> {
    a::range(log, ctx.str("from"), ctx.str("to"), ctx.str("mode"), ctx.flag("armed")).map_err(usage)
}

fn round(v: f64, places: i32) -> Value {
    if !v.is_finite() {
        return Value::Null;
    }
    let k = 10f64.powi(places);
    json!((v * k).round() / k)
}

/// The fields' samples in range, lined up on the first field's timestamps
/// (or a fixed grid with `--rate`).
fn table(log: &a::Log, specs: &[a::FieldSpec], range: &a::Range, rate: Option<f64>) -> CliResult<(Vec<f64>, Vec<Vec<f64>>, usize)> {
    let all: Vec<a::Series> = specs.iter().map(|s| a::series(log, s).map_err(usage)).collect::<Result<_, _>>()?;
    let first = a::clip(&all[0], range);
    let samples = first.t.len();
    let t = match rate {
        Some(r) if r > 0.0 => a::grid(range, r),
        Some(_) => return Err(CliError::new("usage", "--rate must be more than 0")),
        None => first.t.clone(),
    };
    if t.is_empty() {
        return Err(not_enough(format!("no {} samples in that range", specs[0].label)));
    }
    let columns = all
        .iter()
        .enumerate()
        .map(|(i, s)| if i == 0 && rate.is_none() { first.v.clone() } else { a::align(s, &t) })
        .collect();
    Ok((t, columns, samples))
}

/// One field's samples for `logs export`: numbers or text.
enum Samples {
    Numbers(a::Series),
    Text(a::Series<String>),
}

impl Samples {
    fn read(log: &a::Log, spec: &a::FieldSpec) -> CliResult<Samples> {
        if a::is_text(log, spec) {
            a::text_series(log, spec).map(Samples::Text).map_err(usage)
        } else {
            a::series(log, spec).map(Samples::Numbers).map_err(usage)
        }
    }

    fn clip(&self, range: &a::Range) -> Samples {
        match self {
            Samples::Numbers(s) => Samples::Numbers(a::clip(s, range)),
            Samples::Text(s) => Samples::Text(a::clip(s, range)),
        }
    }

    fn times(&self) -> &[f64] {
        match self {
            Samples::Numbers(s) => &s.t,
            Samples::Text(s) => &s.t,
        }
    }

    /// The samples' own values.
    fn cells(self) -> Vec<Value> {
        match self {
            Samples::Numbers(s) => s.v.into_iter().map(number_cell).collect(),
            Samples::Text(s) => s.v.into_iter().map(Value::String).collect(),
        }
    }

    /// Values at the times in `at`: numbers interpolated, text held from
    /// its latest sample.
    fn cells_at(&self, at: &[f64]) -> Vec<Value> {
        match self {
            Samples::Numbers(s) => a::align(s, at).into_iter().map(number_cell).collect(),
            Samples::Text(s) => a::hold(s, at).into_iter().map(|v| v.map_or(Value::Null, Value::String)).collect(),
        }
    }
}

fn number_cell(v: f64) -> Value {
    if v.is_finite() { json!(v) } else { Value::Null }
}

/// `table` for `logs export`, which also takes text fields. Fields of the
/// first field's message and instance are read off the same records, so
/// records sharing a timestamp (PARM at boot) keep their own values.
fn export_table(log: &a::Log, specs: &[a::FieldSpec], range: &a::Range, rate: Option<f64>) -> CliResult<(Vec<f64>, Vec<Vec<Value>>)> {
    let all: Vec<Samples> = specs.iter().map(|s| Samples::read(log, s)).collect::<Result<_, _>>()?;
    let t = match rate {
        Some(r) if r > 0.0 => a::grid(range, r),
        Some(_) => return Err(CliError::new("usage", "--rate must be more than 0")),
        None => all[0].clip(range).times().to_vec(),
    };
    if t.is_empty() {
        return Err(not_enough(format!("no {} samples in that range", specs[0].label)));
    }
    let same_records =
        |s: &a::FieldSpec| rate.is_none() && s.message == specs[0].message && s.instance.unwrap_or(0) == specs[0].instance.unwrap_or(0);
    let columns = specs
        .iter()
        .zip(&all)
        .map(|(spec, samples)| {
            if same_records(spec) {
                let own = samples.clip(range);
                if own.times().len() == t.len() {
                    return own.cells();
                }
            }
            samples.cells_at(&t)
        })
        .collect();
    Ok((t, columns))
}

fn series_reply(t: Vec<f64>, columns: Vec<Vec<f64>>, labels: Vec<String>, samples: usize, max: usize) -> Value {
    let (t, columns, averaged) = match a::bucket(&t, &columns, max) {
        Some((bt, bc)) => (bt, bc, true),
        None => (t, columns, false),
    };
    let rows: Vec<Value> = (0..t.len())
        .map(|i| {
            let mut row = vec![round(t[i], 3)];
            row.extend(columns.iter().map(|c| round(c[i], 4)));
            Value::Array(row)
        })
        .collect();
    let mut names = vec!["t".to_string()];
    names.extend(labels);
    json!({"columns": names, "rows": rows, "samples": samples, "averaged": averaged})
}

fn stats_reply(fields: Vec<(String, Vec<f64>)>) -> CliResult {
    let rows: Vec<Value> = fields
        .into_iter()
        .map(|(label, values)| {
            let s = a::stats(&values).ok_or_else(|| not_enough(format!("no {label} samples in that range")))?;
            Ok(json!({
                "field": label, "n": s.n, "min": round(s.min, 4), "max": round(s.max, 4), "mean": round(s.mean, 4),
                "rms": round(s.rms, 4), "std": round(s.std, 4), "p5": round(s.p5, 4), "p50": round(s.p50, 4), "p95": round(s.p95, 4),
            }))
        })
        .collect::<CliResult<_>>()?;
    Ok(json!({"fields": rows}))
}

fn fft_reply(ctx: &Ctx, fields: Vec<(String, a::Series)>) -> CliResult {
    let nfft = ctx.u64("nfft").unwrap_or(1024) as usize;
    let count = ctx.u64("peaks").unwrap_or(3) as usize;
    let bins = ctx.u64("bins").map(|b| b as usize);
    let mut sample_rate = 0.0;
    let mut resolution = 0.0;
    let mut seconds = 0.0f64;
    let mut rows = Vec::new();
    let mut spectra = Vec::new();
    for (label, s) in fields {
        let spectrum = a::welch(&s, nfft).map_err(not_enough)?;
        spectra.push(json!({
            "field": label,
            "bins": a::bins(&spectrum, 160).into_iter().map(|(hz, db)| [round(hz, 1), round(db, 1)]).collect::<Vec<_>>(),
        }));
        sample_rate = spectrum.sample_rate;
        resolution = spectrum.resolution;
        seconds = seconds.max(s.t.last().unwrap_or(&0.0) - s.t.first().unwrap_or(&0.0));
        let peaks: Vec<Value> = a::peaks(&spectrum, count).into_iter().map(|(hz, db)| json!({"hz": round(hz, 1), "db": round(db, 1)})).collect();
        let binned = bins.map(|n| a::bins(&spectrum, n).into_iter().map(|(hz, db)| json!({"hz": round(hz, 1), "db": round(db, 1)})).collect::<Vec<_>>());
        rows.push(json!({"field": label, "peaks": peaks, "bins": binned}));
    }
    ctx.set_view(json!({"spectra": spectra}));
    Ok(json!({"sampleRate": round(sample_rate, 1), "resolution": round(resolution, 3), "seconds": round(seconds, 1), "fields": rows}))
}

pub async fn analyze(ctx: &Ctx) -> CliResult {
    let raw = ctx.str("log").unwrap_or_default().to_string();
    let path = resolve(ctx, &raw).await?;
    ctx.authorize(json!({"kind": "command", "log": path.to_string_lossy()})).await?;
    ctx.progress(json!({"text": format!("reading {}", path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default())}));
    let log = a::open(&ctx.app, path.clone()).map_err(|e| CliError::new("bad_file", format!("couldn't read {}: {e}", path.display())))?;
    if log.parsed.log.tables().len() <= 1 {
        return Err(CliError::new("bad_file", format!("{} isn't a dataflash log", path.display())));
    }
    let file = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();

    match ctx.def.name {
        "logs info" => {
            let tables: Vec<_> = log.parsed.log.tables().iter().filter(|t| t.name != "FMT").collect();
            let records: usize = tables.iter().map(|t| t.len()).sum();
            let start = a::start_unix(&log).map(|s| ctx.iso((s * 1000.0) as u64));
            Ok(json!({
                "file": file,
                "path": path.to_string_lossy(),
                "bytes": log.bytes.len(),
                "firmware": a::firmware(&log),
                "start": start,
                "duration": round(a::duration(&log), 1),
                "types": tables.len(),
                "records": records,
            }))
        }
        "logs schema" => {
            let duration = a::duration(&log).max(1e-9);
            let wanted = ctx.str("message");
            let mut names: Vec<&String> = log.parsed.log.tables().iter().map(|t| &t.name).filter(|n| *n != "FMT").filter(|n| wanted.is_none_or(|w| n.eq_ignore_ascii_case(w))).collect();
            if names.is_empty() {
                return Err(CliError::new("not_found", format!("the log has no {} messages", wanted.unwrap_or("?"))));
            }
            names.sort();
            let messages: Vec<Value> = names
                .into_iter()
                .map(|name| {
                    let table = log.parsed.table(name).expect("listed above");
                    let count = table.len();
                    let fields: Vec<Value> = table
                        .columns
                        .iter()
                        .filter(|f| f.name != "TimeUS")
                        .map(|f| json!({"name": f.name, "unit": a::unit_of(&log, name, &f.name)}))
                        .collect();
                    json!({"name": name, "rate": round(count as f64 / duration, 1), "count": count, "fields": fields})
                })
                .collect();
            Ok(json!({"messages": messages}))
        }
        "logs events" => {
            let types = ctx.list("types");
            for t in &types {
                if !["MSG", "ERR", "EV", "MODE"].iter().any(|k| k.eq_ignore_ascii_case(t)) {
                    return Err(CliError::new("usage", format!("{t} isn't MSG, ERR, EV or MODE")));
                }
            }
            let events: Vec<Value> =
                a::events(&log, &types).into_iter().map(|(t, kind, text)| json!({"t": round(t, 2), "type": kind, "text": text})).collect();
            Ok(json!({"events": events}))
        }
        "logs segments" => {
            let segs = a::segments(&log);
            let armed_at = |t: f64| segs.armed.iter().any(|(lo, hi)| t >= *lo && t <= *hi);
            let modes: Vec<Value> = segs
                .modes
                .iter()
                .map(|(m, from, to)| json!({"mode": m, "from": round(*from, 2), "to": round(*to, 2), "armed": armed_at((from + to) / 2.0)}))
                .collect();
            let armed: Vec<Value> = segs.armed.iter().map(|(from, to)| json!({"from": round(*from, 2), "to": round(*to, 2)})).collect();
            Ok(json!({"segments": modes, "armed": armed}))
        }
        "logs series" => {
            let specs = a::parse_fields(ctx.str("fields").unwrap_or_default()).map_err(usage)?;
            let range = range(ctx, &log)?;
            let (t, columns, samples) = table(&log, &specs, &range, ctx.f64("rate"))?;
            let labels = specs.iter().map(|s| s.label.clone()).collect();
            Ok(series_reply(t, columns, labels, samples, ctx.u64("max").unwrap_or(200) as usize))
        }
        "logs stats" => {
            let specs = a::parse_fields(ctx.str("fields").unwrap_or_default()).map_err(usage)?;
            let range = range(ctx, &log)?;
            let fields = specs
                .iter()
                .map(|s| Ok((s.label.clone(), a::clip(&a::series(&log, s).map_err(usage)?, &range).v)))
                .collect::<CliResult<Vec<_>>>()?;
            stats_reply(fields)
        }
        "logs fft" => {
            let specs = a::parse_fields(ctx.str("fields").unwrap_or_default()).map_err(usage)?;
            let range = range(ctx, &log)?;
            let fields = specs
                .iter()
                .map(|s| Ok((s.label.clone(), a::clip(&a::series(&log, s).map_err(usage)?, &range))))
                .collect::<CliResult<Vec<_>>>()?;
            fft_reply(ctx, fields)
        }
        "logs track-error" => {
            let specs = a::parse_fields(ctx.str("fields").unwrap_or_default()).map_err(usage)?;
            if specs.len() != 2 {
                return Err(CliError::new("usage", "track-error takes exactly two fields: DESIRED,ACTUAL"));
            }
            let range = range(ctx, &log)?;
            let desired = a::clip(&a::series(&log, &specs[0]).map_err(usage)?, &range);
            let actual = a::series(&log, &specs[1]).map_err(usage)?;
            let r = a::track_error(&desired, &actual).map_err(not_enough)?;
            Ok(json!({
                "rms": round(r.rms, 3), "max": round(r.max, 3), "mean": round(r.mean, 3), "lagMs": round(r.lag_ms, 0),
                "samples": r.samples, "units": a::unit_of(&log, &specs[0].message, &specs[0].field),
            }))
        }
        "logs eval" => {
            let text = ctx.str("expr").unwrap_or_default().to_string();
            let parsed = expr::parse(&text).map_err(|e| CliError::new("usage", format!("{text}: {e}")))?;
            let mut names = Vec::new();
            expr::fields(&parsed, &mut names);
            if names.is_empty() {
                return Err(CliError::new("usage", "the expression doesn't use any fields"));
            }
            let specs: Vec<a::FieldSpec> = names.iter().map(|n| a::parse_field(n)).collect::<Result<_, _>>().map_err(usage)?;
            let range = range(ctx, &log)?;
            let rate = if ctx.flag("series") { ctx.f64("rate") } else { None };
            let (t, columns, samples) = table(&log, &specs, &range, rate)?;
            let lookup = |name: &str| names.iter().position(|n| n == name).map(|i| columns[i].clone()).unwrap_or_default();
            let values = expr::eval(&parsed, &t, &lookup).map_err(|e| CliError::new("usage", e))?;
            if ctx.flag("series") {
                Ok(series_reply(t, vec![values], vec![text], samples, ctx.u64("max").unwrap_or(200) as usize))
            } else if ctx.flag("fft") {
                let finite: Vec<(f64, f64)> = t.iter().zip(&values).filter(|(_, v)| v.is_finite()).map(|(t, v)| (*t, *v)).collect();
                let s = a::Series { t: finite.iter().map(|p| p.0).collect(), v: finite.iter().map(|p| p.1).collect() };
                fft_reply(ctx, vec![(text, s)])
            } else {
                stats_reply(vec![(text, values)])
            }
        }
        "logs export" => {
            let specs = a::parse_fields(ctx.str("fields").unwrap_or_default()).map_err(usage)?;
            let range = range(ctx, &log)?;
            let (t, columns) = export_table(&log, &specs, &range, ctx.f64("rate"))?;
            let start = log.parsed.start_us as f64;
            let mut columns: Vec<_> = columns.into_iter().map(Vec::into_iter).collect();
            let rows: Vec<Value> = t
                .iter()
                .map(|t| {
                    let mut row = vec![json!((start + t * 1e6).round() as u64)];
                    row.extend(columns.iter_mut().map(|c| c.next().unwrap_or(Value::Null)));
                    Value::Array(row)
                })
                .collect();
            let mut names = vec!["t_us".to_string()];
            names.extend(specs.iter().map(|s| s.label.clone()));
            Ok(json!({"columns": names, "rows": rows, "path": ctx.str("out")}))
        }
        other => Err(CliError::new("usage", format!("{other} isn't a log analysis command"))),
    }
}
