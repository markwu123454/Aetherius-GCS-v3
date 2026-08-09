//! Decodes ArduPilot's dataflash binary log format — the same `.bin` file
//! `download_log` (see `logs/mod.rs`) saves to disk. It's self-describing:
//! every record is `0xA3 0x95 <type>` followed by a payload whose layout is
//! declared earlier in the same file by a `FMT` record for that type (name,
//! total record length, and a format-code string with one letter per
//! field). `FMT`'s own layout is the one exception — it has to be known in
//! advance to bootstrap parsing at all, so it's hardcoded here exactly as
//! ArduPilot declares it (verified against a real downloaded log, not
//! guessed from the spec).

use std::{collections::HashMap, fs, path::Path};

const SYNC1: u8 = 0xA3;
const SYNC2: u8 = 0x95;
const FMT_MSG_ID: u8 = 0x80;

/// One field within a message format, as declared by that message's `FMT`
/// record — a name (from the `Columns` list) paired with a single-letter
/// type code (from the `Format` string) at the matching position.
#[derive(Clone)]
pub struct FieldDef {
    pub name: String,
    pub code: char,
}

/// One message type's layout. `id` is the byte tagging every record of
/// this type in the stream; `length` is the *total* record length
/// including the 3-byte header, exactly as `FMT` itself reports it — used
/// directly to jump from one record to the next during parsing.
#[derive(Clone)]
pub struct MessageFormat {
    pub id: u8,
    pub name: String,
    pub length: usize,
    pub fields: Vec<FieldDef>,
}

/// One decoded field value. Numeric fields — including the centi-scaled
/// (`c`/`C`/`e`/`E`) and 64-byte-array (`a`) codes — are normalized to
/// `f64`; character fields stay text. `L` (ArduPilot's lat/lon degE7 code)
/// is left as a raw `i32` rather than scaled to degrees here — nothing
/// using it yet, and scaling belongs next to whatever first needs degrees
/// rather than being guessed at in the generic decoder.
#[derive(Clone, Debug)]
pub enum FieldValue {
    Number(f64),
    Text(String),
}

impl FieldValue {
    pub fn as_f64(&self) -> Option<f64> {
        match self {
            FieldValue::Number(n) => Some(*n),
            FieldValue::Text(_) => None,
        }
    }
}

/// The result of one full pass over a log file: every message format it
/// declared (keyed by name, since that's how callers ask for a message
/// type) and a byte-offset index — one entry per record, pointing at that
/// record's payload just past its 3-byte header — keyed the same way. Built
/// once by `parse_index` and cached by path in `AnalysisState`; later field
/// queries seek straight to these offsets instead of re-walking the file.
pub struct ParsedLog {
    pub formats: HashMap<String, MessageFormat>,
    pub offsets: HashMap<String, Vec<u64>>,
    pub start_us: u64,
    pub end_us: u64,
}

/// `FMT`'s own layout — `BBnNZ`: `Type,Length,Name,Format,Columns`. Fixed
/// and never itself declared by an earlier `FMT` record, so parsing has to
/// start knowing it.
fn fmt_message_format() -> MessageFormat {
    MessageFormat {
        id: FMT_MSG_ID,
        name: "FMT".to_string(),
        length: 89,
        fields: vec![
            FieldDef { name: "Type".to_string(), code: 'B' },
            FieldDef { name: "Length".to_string(), code: 'B' },
            FieldDef { name: "Name".to_string(), code: 'n' },
            FieldDef { name: "Format".to_string(), code: 'N' },
            FieldDef { name: "Columns".to_string(), code: 'Z' },
        ],
    }
}

/// Byte width of one format code. `0` means "not recognized" — callers
/// treat that as a reason to stop decoding the current record rather than
/// guess a width and misalign everything after it.
fn field_width(code: char) -> usize {
    match code {
        'b' | 'B' | 'M' => 1,
        'h' | 'H' | 'c' | 'C' => 2,
        'i' | 'I' | 'f' | 'e' | 'E' | 'L' | 'n' => 4,
        'N' => 16,
        'Z' | 'a' => 64,
        'q' | 'Q' | 'd' => 8,
        _ => 0,
    }
}

/// Trims at the first NUL (or the whole slice, if there isn't one) and
/// decodes the rest as UTF-8, lossily — dataflash text fields are
/// fixed-width and NUL-padded, not length-prefixed.
fn cstr(raw: &[u8]) -> String {
    let end = raw.iter().position(|&b| b == 0).unwrap_or(raw.len());
    String::from_utf8_lossy(&raw[..end]).into_owned()
}

fn decode_field(code: char, raw: &[u8]) -> FieldValue {
    match code {
        'b' => FieldValue::Number(raw[0] as i8 as f64),
        'B' | 'M' => FieldValue::Number(raw[0] as f64),
        'h' => FieldValue::Number(i16::from_le_bytes([raw[0], raw[1]]) as f64),
        'H' => FieldValue::Number(u16::from_le_bytes([raw[0], raw[1]]) as f64),
        'c' => FieldValue::Number(i16::from_le_bytes([raw[0], raw[1]]) as f64 / 100.0),
        'C' => FieldValue::Number(u16::from_le_bytes([raw[0], raw[1]]) as f64 / 100.0),
        'i' | 'L' => FieldValue::Number(i32::from_le_bytes([raw[0], raw[1], raw[2], raw[3]]) as f64),
        'I' => FieldValue::Number(u32::from_le_bytes([raw[0], raw[1], raw[2], raw[3]]) as f64),
        'e' => FieldValue::Number(i32::from_le_bytes([raw[0], raw[1], raw[2], raw[3]]) as f64 / 100.0),
        'E' => FieldValue::Number(u32::from_le_bytes([raw[0], raw[1], raw[2], raw[3]]) as f64 / 100.0),
        'f' => FieldValue::Number(f32::from_le_bytes([raw[0], raw[1], raw[2], raw[3]]) as f64),
        'd' => FieldValue::Number(f64::from_le_bytes(raw[0..8].try_into().unwrap())),
        'q' => FieldValue::Number(i64::from_le_bytes(raw[0..8].try_into().unwrap()) as f64),
        'Q' => FieldValue::Number(u64::from_le_bytes(raw[0..8].try_into().unwrap()) as f64),
        'n' | 'N' | 'Z' => FieldValue::Text(cstr(raw)),
        // int16_t[32] — not a chartable scalar and nothing needs it decoded
        // yet; kept as an opaque placeholder rather than the width-0 "give
        // up on this record" path, since it still needs to advance past.
        'a' => FieldValue::Text(format!("[{} values]", raw.len() / 2)),
        _ => FieldValue::Text(format!("0x{}", raw.iter().map(|b| format!("{b:02x}")).collect::<String>())),
    }
}

/// Decodes one record's payload (everything after its 3-byte header) into
/// named field values per `fmt`. Stops early — returning whatever fields
/// decoded so far — on an unrecognized type code or a payload shorter than
/// `fmt` declares, rather than panicking on a malformed or truncated
/// record.
pub fn decode_record(payload: &[u8], fmt: &MessageFormat) -> HashMap<String, FieldValue> {
    let mut out = HashMap::with_capacity(fmt.fields.len());
    let mut pos = 0usize;
    for field in &fmt.fields {
        let width = field_width(field.code);
        if width == 0 || pos + width > payload.len() {
            break;
        }
        out.insert(field.name.clone(), decode_field(field.code, &payload[pos..pos + width]));
        pos += width;
    }
    out
}

/// Decodes a `FMT` record's payload into the `MessageFormat` it declares.
/// `None` if the payload is shorter than `FMT`'s own fixed 86 bytes — a
/// truncated final record, most likely.
fn decode_fmt_declaration(payload: &[u8]) -> Option<MessageFormat> {
    if payload.len() < 86 {
        return None;
    }
    let id = payload[0];
    let length = payload[1] as usize;
    let name = cstr(&payload[2..6]);
    let format_codes = cstr(&payload[6..22]);
    let columns = cstr(&payload[22..86]);
    let column_names: Vec<&str> = if columns.is_empty() { Vec::new() } else { columns.split(',').collect() };
    let fields = format_codes
        .chars()
        .zip(column_names.iter())
        .map(|(code, name)| FieldDef { name: name.to_string(), code })
        .collect();
    Some(MessageFormat { id, name, length, fields })
}

/// Walks the whole file once, registering every `FMT`-declared message
/// format as it's seen and indexing every other record's payload offset by
/// message name. Jumps record-to-record using each format's own declared
/// `length` (the format itself isn't escaped/byte-stuffed, so this is
/// exact) rather than re-scanning for sync bytes — except when a header
/// doesn't match what's expected, where it falls back to hunting
/// byte-by-byte for the next `0xA3 0x95` pair to resync past corruption or
/// a type with no `FMT` seen yet.
pub fn parse_index(path: &Path) -> Result<ParsedLog, String> {
    let data = fs::read(path).map_err(|e| e.to_string())?;

    let mut by_id: HashMap<u8, MessageFormat> = HashMap::new();
    let fmt0 = fmt_message_format();
    by_id.insert(fmt0.id, fmt0);

    let mut offsets: HashMap<String, Vec<u64>> = HashMap::new();
    let mut start_us: Option<u64> = None;
    let mut end_us: u64 = 0;

    let mut i = 0usize;
    while i + 3 <= data.len() {
        if data[i] != SYNC1 || data[i + 1] != SYNC2 {
            i += 1;
            continue;
        }
        let msg_id = data[i + 2];
        let Some(fmt) = by_id.get(&msg_id).cloned() else {
            i += 1;
            continue;
        };
        let payload_start = i + 3;
        let payload_len = fmt.length.saturating_sub(3);
        let Some(payload) = data.get(payload_start..payload_start + payload_len) else {
            break; // truncated final record
        };

        if msg_id == FMT_MSG_ID {
            if let Some(declared) = decode_fmt_declaration(payload) {
                by_id.insert(declared.id, declared);
            }
        } else {
            let values = decode_record(payload, &fmt);
            if let Some(t) = values.get("TimeUS").and_then(FieldValue::as_f64) {
                let t = t as u64;
                start_us.get_or_insert(t);
                end_us = end_us.max(t);
            }
            offsets.entry(fmt.name.clone()).or_default().push(payload_start as u64);
        }

        i = payload_start + payload_len;
    }

    let formats: HashMap<String, MessageFormat> = by_id.into_values().map(|f| (f.name.clone(), f)).collect();
    Ok(ParsedLog { formats, offsets, start_us: start_us.unwrap_or(0), end_us })
}
