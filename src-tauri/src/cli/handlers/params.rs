//! `params get / describe / set / diff / apply / save / refresh`.

use std::time::{Duration, Instant};

use aetherius_cli::catalog::Category;
use serde_json::{json, Value};

use super::{glob, is_plane, plain};
use crate::cli::{
    ctx::{vehicle_error, CliError, CliResult, Ctx},
    metadata::{self, ParamDoc},
};

struct Live {
    name: String,
    value: f32,
    kind: &'static str,
}

impl Live {
    fn integer(&self) -> bool {
        !self.kind.starts_with("REAL")
    }
}

/// The cached values, waiting for a fetch still in progress to finish.
async fn live(ctx: &Ctx) -> CliResult<Vec<Live>> {
    let started = Instant::now();
    let mut last_report = Instant::now();
    loop {
        let (loaded, total) = crate::params::loaded_counts(&ctx.app);
        let complete = total.is_some_and(|t| loaded >= t as usize);
        if complete || started.elapsed() > Duration::from_secs(90) {
            if loaded == 0 {
                return Err(CliError::new("vehicle_error", "no parameters have been read from the vehicle yet"));
            }
            break;
        }
        if last_report.elapsed() > Duration::from_secs(1) {
            last_report = Instant::now();
            ctx.progress(json!({"text": format!("loading parameters {loaded}/{}", total.map(|t| t.to_string()).unwrap_or("?".into()))}));
        }
        ctx.check()?;
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    Ok(crate::params::cached_values(&ctx.app).into_iter().map(|(name, value, kind)| Live { name, value, kind }).collect())
}

fn docs(ctx: &Ctx) -> Option<metadata::Docs> {
    metadata::docs(&ctx.app, is_plane(ctx))
}

fn is_pattern(text: &str) -> bool {
    text.contains('*') || text.contains('?')
}

/// The live values named or matched by `selectors`, in name order, and the
/// names the vehicle doesn't have. Fails only if nothing was found and a name
/// was missing.
fn select<'a>(all: &'a [Live], selectors: &[String]) -> CliResult<(Vec<&'a Live>, Vec<String>)> {
    let mut picked: Vec<&Live> = Vec::new();
    let mut missing: Vec<String> = Vec::new();
    for selector in selectors {
        if is_pattern(selector) {
            picked.extend(all.iter().filter(|p| glob(selector, &p.name)));
        } else if let Some(found) = all.iter().find(|p| p.name.eq_ignore_ascii_case(selector)) {
            picked.push(found);
        } else if !missing.iter().any(|m| m.eq_ignore_ascii_case(selector)) {
            missing.push(selector.clone());
        }
    }
    picked.sort_by(|a, b| a.name.cmp(&b.name));
    picked.dedup_by(|a, b| a.name == b.name);
    if picked.is_empty() && !missing.is_empty() {
        let noun = if missing.len() == 1 { "parameter" } else { "parameters" };
        return Err(CliError::new("unknown_param", format!("the vehicle has no {noun} {}", missing.join(", "))));
    }
    Ok((picked, missing))
}

pub async fn get(ctx: &Ctx) -> CliResult {
    let all = live(ctx).await?;
    let (picked, missing) = select(&all, &ctx.list("names"))?;
    ctx.authorize(plain()).await?;
    let docs = docs(ctx);
    let params: Vec<Value> = picked
        .iter()
        .map(|p| {
            let units = docs.as_ref().and_then(|d| d.get(&p.name)).and_then(|d| d.units.clone());
            json!({"name": p.name, "value": p.value, "type": p.kind, "units": units})
        })
        .collect();
    Ok(json!({"params": params, "missing": missing}))
}

pub async fn describe(ctx: &Ctx) -> CliResult {
    let all = live(ctx).await?;
    let (picked, missing) = select(&all, &ctx.list("names"))?;
    ctx.authorize(plain()).await?;
    let docs = docs(ctx);
    let params: Vec<Value> = picked
        .iter()
        .map(|p| {
            let doc = docs.as_ref().and_then(|d| d.get(&p.name)).cloned().unwrap_or_else(|| ParamDoc { name: p.name.clone(), ..Default::default() });
            let bitmask = doc.bitmask.as_ref().map(|bits| {
                let value = p.value as i64;
                bits.iter()
                    .map(|b| {
                        let bit = b.value as u32;
                        json!({"bit": bit, "label": b.label, "set": bit < 63 && value & (1i64 << bit) != 0})
                    })
                    .collect::<Vec<_>>()
            });
            json!({
                "name": p.name,
                "humanName": doc.human_name,
                "description": doc.description,
                "value": p.value,
                "units": doc.units,
                "range": doc.range,
                "increment": doc.increment,
                "values": doc.values.as_ref().map(|v| v.iter().map(|c| json!({"value": c.value, "label": c.label})).collect::<Vec<_>>()),
                "bitmask": bitmask,
                "level": doc.user,
                "rebootRequired": doc.reboot_required,
            })
        })
        .collect();
    Ok(json!({"params": params, "missing": missing}))
}

#[derive(Debug)]
struct Change {
    name: String,
    from: f32,
    to: f32,
    out_of_range: bool,
    doc: Option<ParamDoc>,
}

/// Checks one requested value against the vehicle's type for it and the
/// documentation. Returns `None` if it equals the current value.
fn check_value(live: &Live, value: f64, doc: Option<&ParamDoc>, allow_out_of_range: bool) -> CliResult<Option<Change>> {
    let name = &live.name;
    if !value.is_finite() {
        return Err(CliError::new("invalid_value", format!("{name} needs a number")));
    }
    if live.integer() && value.fract() != 0.0 {
        return Err(CliError::new("invalid_value", format!("{name} takes whole numbers ({})", live.kind)));
    }
    if let Some(doc) = doc {
        if let Some(values) = &doc.values {
            if !values.is_empty() && !values.iter().any(|c| (c.value - value).abs() < 1e-9) {
                let list = values.iter().map(|c| format!("{} {}", c.value, c.label)).collect::<Vec<_>>().join(", ");
                return Err(CliError::new("invalid_value", format!("{name} takes one of: {list}")));
            }
        }
        if let Some(bits) = &doc.bitmask {
            if value < 0.0 || value.fract() != 0.0 {
                return Err(CliError::new("invalid_value", format!("{name} is a bitmask and takes a whole number ≥ 0")));
            }
            let allowed: u64 = bits.iter().filter(|b| b.value < 63.0).map(|b| 1u64 << b.value as u64).fold(0, |a, b| a | b);
            let v = value as u64;
            if v & !allowed != 0 {
                return Err(CliError::new("invalid_value", format!("{name} has no bit for {}", v & !allowed)));
            }
        }
    }
    let out_of_range = doc
        .and_then(|d| d.range.as_ref())
        .filter(|r| r.len() == 2)
        .is_some_and(|r| value < r[0] - 1e-9 || value > r[1] + 1e-9);
    if out_of_range && !allow_out_of_range {
        let range = doc.and_then(|d| d.range.clone()).unwrap_or_default();
        return Err(CliError::new(
            "out_of_range",
            format!("{name} = {value} is outside {} – {} (pass --allow-out-of-range to set it anyway)", range[0], range[1]),
        ));
    }
    let to = value as f32;
    if to == live.value {
        return Ok(None);
    }
    Ok(Some(Change { name: name.clone(), from: live.value, to, out_of_range, doc: doc.cloned() }))
}

fn approval(changes: &[Change]) -> Value {
    json!({
        "kind": "paramChanges",
        "changes": changes.iter().map(|c| json!({
            "name": c.name,
            "from": c.from,
            "to": c.to,
            "range": c.doc.as_ref().and_then(|d| d.range.clone()),
            "units": c.doc.as_ref().and_then(|d| d.units.clone()),
            "outOfRange": c.out_of_range,
        })).collect::<Vec<_>>(),
    })
}

/// Shared by `set` and `apply`: asks, writes, confirms.
async fn write_changes(ctx: &Ctx, changes: Vec<Change>, unchanged: Vec<String>, skipped: Vec<String>) -> CliResult {
    let dry_run = ctx.flag("dryRun");
    let force_ask = changes.iter().any(|c| c.out_of_range);
    let reboot_needed = changes.iter().any(|c| c.doc.as_ref().is_some_and(|d| d.reboot_required));
    let detail = approval(&changes);

    if dry_run {
        ctx.authorize_as(Category::Reads, false, false, detail).await?;
    } else if !changes.is_empty() {
        ctx.authorize_as(ctx.def.category, ctx.def.while_armed, force_ask, detail).await?;
    } else {
        ctx.authorize_as(Category::Reads, false, false, detail).await?;
    }

    let total = changes.len();
    let mut rows = Vec::new();
    let mut applied = 0;
    for change in &changes {
        if dry_run {
            rows.push(json!({"name": change.name, "from": change.from, "to": change.to, "confirmed": false, "error": null}));
            continue;
        }
        ctx.check()?;
        match crate::params::set_param(ctx.app.clone(), change.name.clone(), change.to).await {
            Ok(echoed) => {
                applied += 1;
                rows.push(json!({"name": change.name, "from": change.from, "to": echoed, "confirmed": true, "error": null}));
            }
            Err(e) => rows.push(json!({"name": change.name, "from": change.from, "to": change.to, "confirmed": false, "error": e})),
        }
    }

    let data = json!({
        "changes": rows,
        "unchanged": unchanged,
        "skipped": skipped,
        "applied": applied,
        "total": total,
        "rebootNeeded": reboot_needed && applied > 0,
        "dryRun": dry_run,
    });
    if !dry_run && applied < total {
        let failed: Vec<String> = changes.iter().map(|c| c.name.clone()).filter(|n| {
            !data["changes"].as_array().is_some_and(|rows| rows.iter().any(|r| r["name"] == json!(n) && r["confirmed"] == json!(true)))
        }).collect();
        return Err(CliError::new("vehicle_error", format!("{} not confirmed", failed.join(", "))).with_data(data));
    }
    Ok(data)
}

pub async fn set(ctx: &Ctx) -> CliResult {
    let all = live(ctx).await?;
    let docs = docs(ctx);
    let allow = ctx.flag("allowOutOfRange");
    let mut changes = Vec::new();
    let mut unchanged = Vec::new();
    for assignment in ctx.list("assignments") {
        let (name, raw) = assignment
            .split_once('=')
            .ok_or_else(|| CliError::new("usage", format!("{assignment} isn't NAME=VALUE")))?;
        let name = name.trim();
        let current = all
            .iter()
            .find(|p| p.name.eq_ignore_ascii_case(name))
            .ok_or_else(|| CliError::new("unknown_param", format!("the vehicle has no parameter {name}")))?;
        let value: f64 = raw
            .trim()
            .parse()
            .map_err(|_| CliError::new("invalid_value", format!("{} needs a number, got {raw}", current.name)))?;
        match check_value(current, value, docs.as_ref().and_then(|d| d.get(&current.name)), allow)? {
            Some(change) => {
                changes.retain(|c: &Change| c.name != change.name);
                changes.push(change);
            }
            None => unchanged.push(current.name.clone()),
        }
    }
    write_changes(ctx, changes, unchanged, Vec::new()).await
}

/// `NAME,VALUE` lines (also tab or space separated), `#` comments.
fn parse_param_file(text: &str) -> Vec<(String, f64)> {
    let mut out = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut parts = line.split(|c: char| c == ',' || c == '\t' || c == ' ').filter(|p| !p.is_empty());
        let (Some(name), Some(raw)) = (parts.next(), parts.next()) else { continue };
        if let Ok(value) = raw.parse::<f64>() {
            out.push((name.to_string(), value));
        }
    }
    out
}

fn file_entries(ctx: &Ctx) -> CliResult<Vec<(String, f64)>> {
    let entries = parse_param_file(ctx.str("content").unwrap_or_default());
    if entries.is_empty() {
        return Err(CliError::new("bad_file", format!("{} has no NAME,VALUE lines", ctx.str("file").unwrap_or("the file"))));
    }
    Ok(entries)
}

pub async fn diff(ctx: &Ctx) -> CliResult {
    let all = live(ctx).await?;
    let entries = file_entries(ctx)?;
    ctx.authorize(plain()).await?;
    let mut differ = Vec::new();
    let mut same = 0;
    let mut missing = Vec::new();
    for (name, value) in entries {
        match all.iter().find(|p| p.name.eq_ignore_ascii_case(&name)) {
            Some(p) if p.value == value as f32 => same += 1,
            Some(p) => differ.push(json!({"name": p.name, "live": p.value, "file": value as f32})),
            None => missing.push(name),
        }
    }
    Ok(json!({"differ": differ, "same": same, "missing": missing}))
}

pub async fn apply(ctx: &Ctx) -> CliResult {
    let all = live(ctx).await?;
    let entries = file_entries(ctx)?;
    let only = ctx.list("only");
    let docs = docs(ctx);
    let allow = ctx.flag("allowOutOfRange");
    let mut changes = Vec::new();
    let mut unchanged = Vec::new();
    let mut skipped = Vec::new();
    for (name, value) in entries {
        if !only.is_empty() && !only.iter().any(|p| glob(p, &name)) {
            continue;
        }
        let Some(current) = all.iter().find(|p| p.name.eq_ignore_ascii_case(&name)) else {
            skipped.push(name);
            continue;
        };
        match check_value(current, value, docs.as_ref().and_then(|d| d.get(&current.name)), allow)? {
            Some(change) => changes.push(change),
            None => unchanged.push(current.name.clone()),
        }
    }
    // Long lists of unchanged names aren't worth echoing back.
    let unchanged = if unchanged.len() > 20 { Vec::new() } else { unchanged };
    write_changes(ctx, changes, unchanged, skipped).await
}

pub async fn save(ctx: &Ctx) -> CliResult {
    let all = live(ctx).await?;
    let patterns = ctx.list("patterns");
    ctx.authorize(plain()).await?;
    let params: Vec<Value> = all
        .iter()
        .filter(|p| patterns.is_empty() || patterns.iter().any(|pat| glob(pat, &p.name)))
        .map(|p| json!({"name": p.name, "value": p.value}))
        .collect();
    Ok(json!({"params": params, "firmware": super::firmware(ctx), "path": ctx.str("file"), "count": params.len()}))
}

pub async fn refresh(ctx: &Ctx) -> CliResult {
    ctx.authorize(plain()).await?;
    crate::params::start_refresh(&ctx.app).map_err(vehicle_error)?;
    tokio::time::sleep(Duration::from_millis(500)).await;
    let all = live(ctx).await?;
    let (_, total) = crate::params::loaded_counts(&ctx.app);
    Ok(json!({"loaded": all.len(), "total": total}))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn live(name: &str, value: f32, kind: &'static str) -> Live {
        Live { name: name.into(), value, kind }
    }

    fn doc(range: Option<[f64; 2]>) -> ParamDoc {
        ParamDoc { name: "X".into(), range: range.map(|r| r.to_vec()), ..Default::default() }
    }

    #[test]
    fn values_are_checked() {
        let p = live("X", 1.0, "REAL32");
        assert!(check_value(&p, 2.0, Some(&doc(Some([0.0, 5.0]))), false).unwrap().is_some());
        assert!(check_value(&p, 1.0, None, false).unwrap().is_none());
        assert_eq!(check_value(&p, 9.0, Some(&doc(Some([0.0, 5.0]))), false).unwrap_err().code, "out_of_range");
        assert!(check_value(&p, 9.0, Some(&doc(Some([0.0, 5.0]))), true).unwrap().unwrap().out_of_range);
        let i = live("I", 1.0, "INT8");
        assert_eq!(check_value(&i, 1.5, None, false).unwrap_err().code, "invalid_value");
    }

    #[test]
    fn unknown_names_dont_sink_the_batch() {
        let all = vec![live("ATC_RAT_RLL_P", 0.1, "REAL32"), live("INS_HNTCH_BW", 40.0, "REAL32")];
        let names = |list: &[&str]| list.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let (picked, missing) = select(&all, &names(&["atc_rat_rll_p", "NOPE", "nope"])).unwrap();
        assert_eq!(picked.iter().map(|p| p.name.as_str()).collect::<Vec<_>>(), ["ATC_RAT_RLL_P"]);
        assert_eq!(missing, ["NOPE"]);
        assert_eq!(select(&all, &names(&["NOPE", "ZZ_*"])).err().unwrap().code, "unknown_param");
        assert!(select(&all, &names(&["ZZ_*"])).unwrap().0.is_empty());
    }

    #[test]
    fn param_files_parse() {
        let parsed = parse_param_file("# header\nA,1\nB\t2.5\n\nbad line\nC 3\n");
        assert_eq!(parsed, vec![("A".into(), 1.0), ("B".into(), 2.5), ("C".into(), 3.0)]);
    }
}
