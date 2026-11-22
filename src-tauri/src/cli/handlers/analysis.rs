//! Number crunching over a parsed dataflash log for the `logs` commands.
//! Everything runs on full-rate samples; only output gets shortened.

use std::{collections::HashMap, path::PathBuf, sync::Arc};

use crate::logs::parser::{FieldValue, ParsedLog};

pub struct Log {
    pub parsed: Arc<ParsedLog>,
    pub bytes: Vec<u8>,
    pub plane: bool,
}

pub fn duration(log: &Log) -> f64 {
    (log.parsed.end_us.saturating_sub(log.parsed.start_us)) as f64 / 1e6
}

/// Decodes every record of `message`, in file order.
pub fn records<'a>(log: &'a Log, message: &str) -> Vec<HashMap<String, FieldValue>> {
    log.parsed.records(message)
}

fn number(record: &HashMap<String, FieldValue>, field: &str) -> Option<f64> {
    record.get(field).and_then(FieldValue::as_f64)
}

fn text(record: &HashMap<String, FieldValue>, field: &str) -> Option<String> {
    match record.get(field)? {
        FieldValue::Text(s) => Some(s.clone()),
        FieldValue::Number(n) => Some(n.to_string()),
    }
}

/// Seconds from the start of the log.
fn log_secs(log: &Log, record: &HashMap<String, FieldValue>) -> Option<f64> {
    number(record, "TimeUS").map(|t| (t - log.parsed.start_us as f64) / 1e6)
}

pub fn open(app: &tauri::AppHandle, path: PathBuf) -> Result<Log, String> {
    let shown = path.to_string_lossy().to_string();
    let parsed = crate::logs::analysis::parsed_log(app, &shown)?;
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    let mut log = Log { parsed, bytes, plane: false };
    log.plane = records(&log, "MSG").iter().take(20).any(|r| text(r, "Message").is_some_and(|m| m.contains("ArduPlane")));
    Ok(log)
}

/// The field's unit from FMTU/UNIT/MULT, with the multiplier's prefix.
pub fn unit_of(log: &Log, message: &str, field: &str) -> Option<String> {
    log.parsed.table(message)?.column(field)?.unit.clone()
}

fn instance_field(log: &Log, message: &str) -> Option<String> {
    let table = log.parsed.table(message)?;
    if table.instance_field.is_some() {
        return table.instance_field.clone();
    }
    table.columns.iter().find(|c| matches!(c.name.as_str(), "I" | "Instance" | "Inst")).map(|c| c.name.clone())
}

/// `MSG.Field` or `MSG[N].Field`.
#[derive(Clone, Debug, PartialEq)]
pub struct FieldSpec {
    pub message: String,
    pub instance: Option<u32>,
    pub field: String,
    pub label: String,
}

pub fn parse_field(text: &str) -> Result<FieldSpec, String> {
    let text = text.trim();
    let (head, field) = text.rsplit_once('.').ok_or_else(|| format!("{text} isn't MSG.Field"))?;
    let (message, instance) = match head.split_once('[') {
        Some((m, rest)) => {
            let n = rest.strip_suffix(']').and_then(|n| n.parse().ok()).ok_or_else(|| format!("{text}: bad instance"))?;
            (m.to_string(), Some(n))
        }
        None => (head.to_string(), None),
    };
    if message.is_empty() || field.is_empty() {
        return Err(format!("{text} isn't MSG.Field"));
    }
    Ok(FieldSpec { message, instance, field: field.to_string(), label: text.to_string() })
}

pub fn parse_fields(text: &str) -> Result<Vec<FieldSpec>, String> {
    let specs: Vec<FieldSpec> = text.split(',').filter(|s| !s.trim().is_empty()).map(parse_field).collect::<Result<_, _>>()?;
    if specs.is_empty() {
        return Err("no fields given".to_string());
    }
    Ok(specs)
}

/// Time (log seconds) and value of every sample of a field, in order.
pub struct Series<V = f64> {
    pub t: Vec<f64>,
    pub v: Vec<V>,
}

/// Whether a field holds text (a name or message) rather than a number.
pub fn is_text(log: &Log, spec: &FieldSpec) -> bool {
    log.parsed
        .table(&spec.message)
        .and_then(|table| table.column(&spec.field))
        .is_some_and(|c| matches!(c.data, flightlog_core::ColumnData::Utf8(_)))
}

pub fn series(log: &Log, spec: &FieldSpec) -> Result<Series, String> {
    if is_text(log, spec) {
        return Err(format!("{} is text; only logs export takes text fields", spec.label));
    }
    samples(log, spec, FieldValue::as_f64)
}

pub fn text_series(log: &Log, spec: &FieldSpec) -> Result<Series<String>, String> {
    samples(log, spec, |v| match v {
        FieldValue::Text(s) => Some(s.clone()),
        FieldValue::Number(_) => None,
    })
}

/// Every sample of a field that `value` can read.
fn samples<V>(log: &Log, spec: &FieldSpec, value: impl Fn(&FieldValue) -> Option<V>) -> Result<Series<V>, String> {
    let table = log.parsed.table(&spec.message).ok_or_else(|| format!("the log has no {} messages", spec.message))?;
    if table.column(&spec.field).is_none() {
        let names: Vec<&str> = table.column_names();
        return Err(format!("{} has no field {} (it has {})", spec.message, spec.field, names.join(", ")));
    }
    let instance = instance_field(log, &spec.message);
    if spec.instance.is_some() && instance.is_none() {
        return Err(format!("{} has only one instance", spec.message));
    }
    let wanted = spec.instance.unwrap_or(0) as f64;
    let mut out = Series { t: Vec::new(), v: Vec::new() };
    for r in records(log, &spec.message) {
        if let Some(field) = &instance {
            if number(&r, field) != Some(wanted) {
                continue;
            }
        }
        let (Some(t), Some(v)) = (log_secs(log, &r), r.get(&spec.field).and_then(&value)) else { continue };
        out.t.push(t);
        out.v.push(v);
    }
    Ok(out)
}

/// Mode changes and armed spans over the log.
pub struct Segments {
    pub modes: Vec<(String, f64, f64)>,
    pub armed: Vec<(f64, f64)>,
}

pub fn segments(log: &Log) -> Segments {
    let end = duration(log);
    let mut changes: Vec<(f64, String)> = records(log, "MODE")
        .iter()
        .filter_map(|r| {
            let t = log_secs(log, r)?;
            let mode = number(r, "Mode").or_else(|| number(r, "ModeNum"))? as u32;
            Some((t, super::modes::name(log.plane, mode)))
        })
        .collect();
    changes.sort_by(|a, b| a.0.total_cmp(&b.0));
    // ArduPilot logs the mode again on some events without it changing.
    changes.dedup_by(|later, earlier| later.1 == earlier.1);
    let modes = changes
        .iter()
        .enumerate()
        .map(|(i, (t, name))| (name.clone(), *t, changes.get(i + 1).map(|n| n.0).unwrap_or(end)))
        .collect();

    // ARM records where the firmware writes them, EV 10/11 otherwise.
    let mut toggles: Vec<(f64, bool)> = records(log, "ARM")
        .iter()
        .filter_map(|r| Some((log_secs(log, r)?, number(r, "ArmState")? > 0.0)))
        .collect();
    if toggles.is_empty() {
        toggles = records(log, "EV")
            .iter()
            .filter_map(|r| {
                let t = log_secs(log, r)?;
                match number(r, "Id")? as u32 {
                    10 => Some((t, true)),
                    11 => Some((t, false)),
                    _ => None,
                }
            })
            .collect();
    }
    toggles.sort_by(|a, b| a.0.total_cmp(&b.0));
    Segments { modes, armed: armed_spans(&toggles, end) }
}

/// Armed spans from time-ordered arm (`true`) and disarm (`false`) toggles.
/// A disarm before any arm means the log started with the vehicle armed.
fn armed_spans(toggles: &[(f64, bool)], end: f64) -> Vec<(f64, f64)> {
    let mut armed = Vec::new();
    let mut since: Option<f64> = toggles.first().filter(|(_, on)| !on).map(|_| 0.0);
    for &(t, on) in toggles {
        match (on, since) {
            (true, None) => since = Some(t),
            (false, Some(start)) => {
                armed.push((start, t));
                since = None;
            }
            _ => {}
        }
    }
    if let Some(start) = since {
        armed.push((start, end));
    }
    armed
}

/// Time spans a range option set allows, in log seconds.
#[derive(Clone, Debug)]
pub struct Range {
    pub spans: Vec<(f64, f64)>,
}

impl Range {
    pub fn contains(&self, t: f64) -> bool {
        self.spans.iter().any(|(a, b)| t >= *a && t <= *b)
    }
}

/// Seconds, or `m:ss(.s)`.
pub fn parse_log_time(text: &str) -> Option<f64> {
    match text.split_once(':') {
        Some((m, s)) => Some(m.trim().parse::<f64>().ok()? * 60.0 + s.trim().parse::<f64>().ok()?),
        None => text.trim().parse().ok(),
    }
}

fn intersect(a: &[(f64, f64)], b: &[(f64, f64)]) -> Vec<(f64, f64)> {
    let mut out = Vec::new();
    for (a0, a1) in a {
        for (b0, b1) in b {
            let (lo, hi) = (a0.max(*b0), a1.min(*b1));
            if lo < hi {
                out.push((lo, hi));
            }
        }
    }
    out
}

pub fn range(log: &Log, from: Option<&str>, to: Option<&str>, mode: Option<&str>, armed: bool) -> Result<Range, String> {
    let end = duration(log);
    let lo = match from {
        Some(t) => parse_log_time(t).ok_or_else(|| format!("--from takes seconds or m:ss, got {t}"))?,
        None => 0.0,
    };
    let hi = match to {
        Some(t) => parse_log_time(t).ok_or_else(|| format!("--to takes seconds or m:ss, got {t}"))?,
        None => end,
    };
    let mut spans = vec![(lo, hi)];
    let segs = if mode.is_some() || armed { Some(segments(log)) } else { None };
    if let Some(mode) = mode {
        let (name, nth) = match mode.split_once('#') {
            Some((n, k)) => (n, k.parse::<usize>().map_err(|_| format!("--mode {mode}: bad #N"))?),
            None => (mode, 1),
        };
        let wanted = super::modes::normalize(name);
        let segs = segs.as_ref().map(|s| &s.modes[..]).unwrap_or_default();
        let matching: Vec<&(String, f64, f64)> = segs.iter().filter(|(m, _, _)| super::modes::normalize(m) == wanted).collect();
        let seg = matching.get(nth.saturating_sub(1)).ok_or_else(|| {
            let seen: Vec<String> = segs.iter().map(|(m, _, _)| m.clone()).collect();
            if matching.is_empty() {
                format!("the vehicle was never in {name} in this log (modes: {})", seen.join(", "))
            } else {
                format!("the vehicle was in {name} only {} time(s)", matching.len())
            }
        })?;
        spans = intersect(&spans, &[(seg.1, seg.2)]);
    }
    if armed {
        let armed_spans = segs.as_ref().map(|s| s.armed.clone()).unwrap_or_default();
        if armed_spans.is_empty() {
            return Err("the log doesn't show the vehicle armed".to_string());
        }
        spans = intersect(&spans, &armed_spans);
    }
    if spans.is_empty() {
        return Err("that range is empty".to_string());
    }
    Ok(Range { spans })
}

pub fn clip<V: Clone>(s: &Series<V>, range: &Range) -> Series<V> {
    let mut out = Series { t: Vec::new(), v: Vec::new() };
    for (t, v) in s.t.iter().zip(&s.v) {
        if range.contains(*t) {
            out.t.push(*t);
            out.v.push(v.clone());
        }
    }
    out
}

/// `s`'s latest value at or before each time in `at`; `None` before its
/// first sample.
pub fn hold<V: Clone>(s: &Series<V>, at: &[f64]) -> Vec<Option<V>> {
    let mut out = Vec::with_capacity(at.len());
    let mut seen = 0;
    for &t in at {
        while seen < s.t.len() && s.t[seen] <= t {
            seen += 1;
        }
        out.push(seen.checked_sub(1).map(|i| s.v[i].clone()));
    }
    out
}

/// `s` linearly interpolated at each time in `at`; NaN outside `s`.
pub fn align(s: &Series, at: &[f64]) -> Vec<f64> {
    let mut out = Vec::with_capacity(at.len());
    let mut j = 0;
    for &t in at {
        if s.t.is_empty() || t < s.t[0] || t > *s.t.last().unwrap() {
            out.push(f64::NAN);
            continue;
        }
        while j + 1 < s.t.len() && s.t[j + 1] < t {
            j += 1;
        }
        if j + 1 >= s.t.len() || s.t[j] == t {
            out.push(s.v[j]);
            continue;
        }
        let (t0, t1) = (s.t[j], s.t[j + 1]);
        let k = if t1 > t0 { (t - t0) / (t1 - t0) } else { 0.0 };
        out.push(s.v[j] + k * (s.v[j + 1] - s.v[j]));
    }
    out
}

/// A fixed-rate time grid over the range.
pub fn grid(range: &Range, rate: f64) -> Vec<f64> {
    let mut out = Vec::new();
    for (lo, hi) in &range.spans {
        let mut t = *lo;
        while t <= *hi {
            out.push(t);
            t += 1.0 / rate;
        }
    }
    out
}

/// Averages rows into at most `max` equal time slices. Returns `None` when
/// there were few enough rows already.
pub fn bucket(t: &[f64], columns: &[Vec<f64>], max: usize) -> Option<(Vec<f64>, Vec<Vec<f64>>)> {
    if max == 0 || t.len() <= max {
        return None;
    }
    let (lo, hi) = (t[0], *t.last().unwrap());
    let width = (hi - lo) / max as f64;
    let mut sums = vec![(0.0, vec![0.0; columns.len()], vec![0usize; columns.len()], 0usize); max];
    for (i, &time) in t.iter().enumerate() {
        let b = (((time - lo) / width) as usize).min(max - 1);
        sums[b].0 += time;
        sums[b].3 += 1;
        for (c, col) in columns.iter().enumerate() {
            if col[i].is_finite() {
                sums[b].1[c] += col[i];
                sums[b].2[c] += 1;
            }
        }
    }
    let mut out_t = Vec::new();
    let mut out_cols = vec![Vec::new(); columns.len()];
    for (time, values, counts, n) in sums {
        if n == 0 {
            continue;
        }
        out_t.push(time / n as f64);
        for c in 0..columns.len() {
            out_cols[c].push(if counts[c] > 0 { values[c] / counts[c] as f64 } else { f64::NAN });
        }
    }
    Some((out_t, out_cols))
}

pub struct Stats {
    pub n: usize,
    pub min: f64,
    pub max: f64,
    pub mean: f64,
    pub std: f64,
    pub rms: f64,
    pub p5: f64,
    pub p50: f64,
    pub p95: f64,
}

fn percentile(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return f64::NAN;
    }
    let pos = p / 100.0 * (sorted.len() - 1) as f64;
    let (i, k) = (pos.floor() as usize, pos.fract());
    if i + 1 < sorted.len() { sorted[i] + k * (sorted[i + 1] - sorted[i]) } else { sorted[i] }
}

pub fn stats(values: &[f64]) -> Option<Stats> {
    let mut v: Vec<f64> = values.iter().copied().filter(|x| x.is_finite()).collect();
    if v.is_empty() {
        return None;
    }
    v.sort_by(f64::total_cmp);
    let n = v.len() as f64;
    let mean = v.iter().sum::<f64>() / n;
    let var = v.iter().map(|x| (x - mean).powi(2)).sum::<f64>() / n;
    let rms = (v.iter().map(|x| x * x).sum::<f64>() / n).sqrt();
    Some(Stats {
        n: v.len(),
        min: v[0],
        max: *v.last().unwrap(),
        mean,
        std: var.sqrt(),
        rms,
        p5: percentile(&v, 5.0),
        p50: percentile(&v, 50.0),
        p95: percentile(&v, 95.0),
    })
}

/// In-place iterative radix-2 FFT; `re.len()` must be a power of two.
fn fft(re: &mut [f64], im: &mut [f64]) {
    let n = re.len();
    let mut j = 0;
    for i in 1..n {
        let mut bit = n >> 1;
        while j & bit != 0 {
            j ^= bit;
            bit >>= 1;
        }
        j |= bit;
        if i < j {
            re.swap(i, j);
            im.swap(i, j);
        }
    }
    let mut len = 2;
    while len <= n {
        let angle = -2.0 * std::f64::consts::PI / len as f64;
        let (wr, wi) = (angle.cos(), angle.sin());
        for start in (0..n).step_by(len) {
            let (mut cr, mut ci) = (1.0, 0.0);
            for k in 0..len / 2 {
                let (a, b) = (start + k, start + k + len / 2);
                let (tr, ti) = (re[b] * cr - im[b] * ci, re[b] * ci + im[b] * cr);
                re[b] = re[a] - tr;
                im[b] = im[a] - ti;
                re[a] += tr;
                im[a] += ti;
                let next = cr * wr - ci * wi;
                ci = cr * wi + ci * wr;
                cr = next;
            }
        }
        len <<= 1;
    }
}

pub struct Spectrum {
    pub sample_rate: f64,
    pub resolution: f64,
    /// Power spectral density per bin, 0 Hz to Nyquist.
    pub psd: Vec<f64>,
}

/// Welch's method: Hann-windowed segments of `nfft` samples, half
/// overlapping, each with its mean removed, averaged.
pub fn welch(s: &Series, nfft: usize) -> Result<Spectrum, String> {
    if !nfft.is_power_of_two() || nfft < 16 {
        return Err("--nfft must be a power of two, 16 or more".to_string());
    }
    let n = s.v.len();
    if n < nfft {
        return Err(format!("only {n} samples in range, fewer than one {nfft}-point segment"));
    }
    let span = s.t[n - 1] - s.t[0];
    if span <= 0.0 {
        return Err("the samples don't span any time".to_string());
    }
    let fs = (n - 1) as f64 / span;
    let window: Vec<f64> = (0..nfft).map(|i| 0.5 - 0.5 * (2.0 * std::f64::consts::PI * i as f64 / nfft as f64).cos()).collect();
    let window_power: f64 = window.iter().map(|w| w * w).sum();
    let mut psd = vec![0.0; nfft / 2 + 1];
    let mut segments = 0;
    let mut start = 0;
    while start + nfft <= n {
        let chunk = &s.v[start..start + nfft];
        let mean = chunk.iter().filter(|v| v.is_finite()).sum::<f64>() / nfft as f64;
        let mut re: Vec<f64> = chunk.iter().zip(&window).map(|(v, w)| if v.is_finite() { (v - mean) * w } else { 0.0 }).collect();
        let mut im = vec![0.0; nfft];
        fft(&mut re, &mut im);
        for (k, p) in psd.iter_mut().enumerate() {
            let mut power = (re[k] * re[k] + im[k] * im[k]) / (fs * window_power);
            if k != 0 && k != nfft / 2 {
                power *= 2.0;
            }
            *p += power;
        }
        segments += 1;
        start += nfft / 2;
    }
    for p in &mut psd {
        *p /= segments as f64;
    }
    Ok(Spectrum { sample_rate: fs, resolution: fs / nfft as f64, psd })
}

pub fn db(power: f64) -> f64 {
    10.0 * power.max(1e-30).log10()
}

/// The `count` strongest local maxima above 1 Hz, at least 1 Hz (and three
/// bins) apart, so one wide peak isn't reported several times.
pub fn peaks(spectrum: &Spectrum, count: usize) -> Vec<(f64, f64)> {
    let psd = &spectrum.psd;
    let first = ((1.0 / spectrum.resolution).ceil() as usize).max(2);
    let apart = ((1.0 / spectrum.resolution).ceil() as usize).max(3);
    let mut candidates: Vec<usize> =
        (first..psd.len().saturating_sub(1)).filter(|&k| psd[k] > psd[k - 1] && psd[k] >= psd[k + 1]).collect();
    candidates.sort_by(|a, b| psd[*b].total_cmp(&psd[*a]));
    let mut chosen: Vec<usize> = Vec::new();
    for k in candidates {
        if chosen.iter().all(|c| c.abs_diff(k) > apart) {
            chosen.push(k);
            if chosen.len() == count {
                break;
            }
        }
    }
    chosen.into_iter().map(|k| (k as f64 * spectrum.resolution, db(psd[k]))).collect()
}

/// The spectrum averaged into `count` equal-width bins.
pub fn bins(spectrum: &Spectrum, count: usize) -> Vec<(f64, f64)> {
    let psd = &spectrum.psd;
    let count = count.clamp(1, psd.len());
    let per = psd.len() as f64 / count as f64;
    (0..count)
        .map(|b| {
            let (lo, hi) = ((b as f64 * per) as usize, (((b + 1) as f64 * per) as usize).min(psd.len()).max((b as f64 * per) as usize + 1));
            let mean = psd[lo..hi].iter().sum::<f64>() / (hi - lo) as f64;
            (((lo + hi) as f64 / 2.0) * spectrum.resolution, db(mean))
        })
        .collect()
}

pub struct TrackError {
    pub rms: f64,
    pub max: f64,
    pub mean: f64,
    pub lag_ms: f64,
    pub samples: usize,
}

pub fn track_error(desired: &Series, actual: &Series) -> Result<TrackError, String> {
    let a = align(actual, &desired.t);
    let pairs: Vec<(f64, f64)> = desired.v.iter().zip(&a).filter(|(d, a)| d.is_finite() && a.is_finite()).map(|(d, a)| (*d, *a)).collect();
    if pairs.len() < 10 {
        return Err("fewer than 10 overlapping samples".to_string());
    }
    let errors: Vec<f64> = pairs.iter().map(|(d, a)| a - d).collect();
    let n = errors.len() as f64;
    let rms = (errors.iter().map(|e| e * e).sum::<f64>() / n).sqrt();
    let max = errors.iter().fold(0.0f64, |m, e| m.max(e.abs()));
    let mean = errors.iter().sum::<f64>() / n;

    // Lag: the shift of `actual` behind `desired` with the best correlation,
    // up to half a second.
    let span = desired.t[desired.t.len() - 1] - desired.t[0];
    let fs = if span > 0.0 { (desired.t.len() - 1) as f64 / span } else { 0.0 };
    let max_lag = ((0.5 * fs) as usize).min(pairs.len() / 4);
    let dm = pairs.iter().map(|p| p.0).sum::<f64>() / n;
    let am = pairs.iter().map(|p| p.1).sum::<f64>() / n;
    let mut best = (0usize, f64::NEG_INFINITY);
    for lag in 0..=max_lag {
        let score: f64 = (0..pairs.len() - lag).map(|i| (pairs[i].0 - dm) * (pairs[i + lag].1 - am)).sum::<f64>() / (pairs.len() - lag) as f64;
        if score > best.1 {
            best = (lag, score);
        }
    }
    let lag_ms = if fs > 0.0 { best.0 as f64 / fs * 1000.0 } else { 0.0 };
    Ok(TrackError { rms, max, mean, lag_ms, samples: pairs.len() })
}

/// Text and time of every MSG, ERR, EV and MODE record asked for.
pub fn events(log: &Log, types: &[String]) -> Vec<(f64, String, String)> {
    let want = |t: &str| types.is_empty() || types.iter().any(|w| w.eq_ignore_ascii_case(t));
    let mut out = Vec::new();
    if want("MSG") {
        for r in records(log, "MSG") {
            if let (Some(t), Some(m)) = (log_secs(log, &r), text(&r, "Message")) {
                out.push((t, "MSG".to_string(), m));
            }
        }
    }
    if want("ERR") {
        for r in records(log, "ERR") {
            if let Some(t) = log_secs(log, &r) {
                let subsys = number(&r, "Subsys").unwrap_or(f64::NAN);
                let code = number(&r, "ECode").unwrap_or(f64::NAN);
                out.push((t, "ERR".to_string(), format!("subsystem {subsys} code {code}")));
            }
        }
    }
    if want("EV") {
        for r in records(log, "EV") {
            if let (Some(t), Some(id)) = (log_secs(log, &r), number(&r, "Id")) {
                let name = match id as u32 {
                    10 => "armed".to_string(),
                    11 => "disarmed".to_string(),
                    15 => "auto armed".to_string(),
                    17 => "land complete maybe".to_string(),
                    18 => "land complete".to_string(),
                    25 => "set home".to_string(),
                    28 => "not landed".to_string(),
                    other => format!("event {other}"),
                };
                out.push((t, "EV".to_string(), name));
            }
        }
    }
    if want("MODE") {
        for r in records(log, "MODE") {
            if let (Some(t), Some(m)) = (log_secs(log, &r), number(&r, "Mode").or_else(|| number(&r, "ModeNum"))) {
                out.push((t, "MODE".to_string(), super::modes::name(log.plane, m as u32)));
            }
        }
    }
    out.sort_by(|a, b| a.0.total_cmp(&b.0));
    out
}

/// The firmware banner (`ArduCopter V4.6.2 (abc1234)`), if the log has one.
pub fn firmware(log: &Log) -> Option<String> {
    records(log, "MSG")
        .iter()
        .take(40)
        .filter_map(|r| text(r, "Message"))
        .find(|m| m.starts_with("Ardu") && m.contains(" V"))
}

/// Unix seconds at the start of the log, from the first GPS fix.
pub fn start_unix(log: &Log) -> Option<f64> {
    for r in records(log, "GPS") {
        let (Some(week), Some(ms), Some(t)) = (number(&r, "GWk"), number(&r, "GMS"), number(&r, "TimeUS")) else { continue };
        if week <= 0.0 || number(&r, "Status").unwrap_or(0.0) < 3.0 {
            continue;
        }
        // GPS epoch 1980-01-06, 18 leap seconds behind UTC.
        let unix = 315_964_800.0 + week * 604_800.0 + ms / 1000.0 - 18.0;
        return Some(unix - (t - log.parsed.start_us as f64) / 1e6);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fields_parse() {
        let f = parse_field("IMU[1].GyrX").unwrap();
        assert_eq!((f.message.as_str(), f.instance, f.field.as_str()), ("IMU", Some(1), "GyrX"));
        assert_eq!(parse_field("RATE.R").unwrap().instance, None);
        assert!(parse_field("RATE").is_err());
        assert_eq!(parse_fields("A.x, B.y").unwrap().len(), 2);
    }

    #[test]
    fn alignment_interpolates() {
        let s = Series { t: vec![0.0, 1.0, 2.0], v: vec![0.0, 10.0, 20.0] };
        let a = align(&s, &[0.5, 1.0, 1.5, 3.0]);
        assert_eq!(&a[..3], &[5.0, 10.0, 15.0]);
        assert!(a[3].is_nan());
    }

    #[test]
    fn stats_work() {
        let s = stats(&[1.0, 2.0, 3.0, 4.0, f64::NAN]).unwrap();
        assert_eq!(s.n, 4);
        assert_eq!(s.mean, 2.5);
        assert_eq!(s.p50, 2.5);
        assert!((s.rms - 2.7386).abs() < 1e-3);
    }

    #[test]
    fn welch_finds_a_tone() {
        let fs = 1000.0;
        let t: Vec<f64> = (0..8192).map(|i| i as f64 / fs).collect();
        let v: Vec<f64> = t.iter().map(|t| (2.0 * std::f64::consts::PI * 162.0 * t).sin() + 0.3 * (2.0 * std::f64::consts::PI * 324.0 * t).sin()).collect();
        let spectrum = welch(&Series { t, v }, 1024).unwrap();
        let found = peaks(&spectrum, 2);
        assert!((found[0].0 - 162.0).abs() < 2.0, "{found:?}");
        assert!((found[1].0 - 324.0).abs() < 2.0, "{found:?}");
        assert_eq!(bins(&spectrum, 10).len(), 10);
    }

    #[test]
    fn lag_is_found() {
        let fs = 400.0;
        let t: Vec<f64> = (0..4000).map(|i| i as f64 / fs).collect();
        let d: Vec<f64> = t.iter().map(|t| (2.0 * std::f64::consts::PI * 1.3 * t).sin()).collect();
        let a: Vec<f64> = t.iter().map(|t| (2.0 * std::f64::consts::PI * 1.3 * (t - 0.02)).sin()).collect();
        let r = track_error(&Series { t: t.clone(), v: d }, &Series { t, v: a }).unwrap();
        assert!((r.lag_ms - 20.0).abs() <= 5.0, "{}", r.lag_ms);
    }

    #[test]
    fn armed_spans_pair_toggles() {
        assert_eq!(armed_spans(&[(5.0, true), (9.0, false)], 20.0), vec![(5.0, 9.0)]);
        assert_eq!(armed_spans(&[(5.0, true)], 20.0), vec![(5.0, 20.0)]);
        assert_eq!(armed_spans(&[(4.0, false), (8.0, true), (12.0, false)], 20.0), vec![(0.0, 4.0), (8.0, 12.0)]);
        assert!(armed_spans(&[], 20.0).is_empty());
    }

    #[test]
    fn hold_keeps_the_latest_value() {
        let s = Series { t: vec![1.0, 2.0, 2.0], v: vec!["a", "b", "c"] };
        assert_eq!(hold(&s, &[0.5, 1.0, 1.5, 2.0, 9.0]), vec![None, Some("a"), Some("a"), Some("c"), Some("c")]);
    }

    #[test]
    fn buckets_average() {
        let t: Vec<f64> = (0..10).map(|i| i as f64).collect();
        let col: Vec<f64> = (0..10).map(|i| i as f64).collect();
        let (bt, bc) = bucket(&t, &[col], 2).unwrap();
        assert_eq!(bt.len(), 2);
        assert_eq!(bc[0], vec![2.0, 7.0]);
    }
}
