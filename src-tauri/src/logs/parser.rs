//! Reads ArduPilot's dataflash binary log format — the same `.bin` file
//! `download_log` (see `logs/mod.rs`) saves to disk — with `flightlog-core`.
//! It decodes every format code (`a` arrays included), applies the format
//! scaling (`c`/`C`/`e`/`E` by 100, `L` lat/lon degE7 to degrees), reads
//! units and multipliers from FMTU/UNIT/MULT, and takes the log's time
//! bounds only from timestamps that agree with their neighbours, so a
//! record misread after a resync can't stretch the log's end.

use std::{collections::HashMap, path::Path};

use flightlog_core::{ColumnData, Log, ReadOptions, Table};

/// One decoded field value. Numeric fields are `f64`, already scaled;
/// character fields stay text, and `a` (int16[32]) arrays are listed as
/// text of their values.
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

/// One full read of a log file: every message type as a column table, and
/// the log's time bounds. Built once by `parse_index` and cached by path in
/// `AnalysisState`.
pub struct ParsedLog {
    pub log: Log,
    pub start_us: u64,
    pub end_us: u64,
}

impl ParsedLog {
    pub fn table(&self, message: &str) -> Option<&Table> {
        self.log.table(message)
    }

    /// Every record of `message`, in file order.
    pub fn records(&self, message: &str) -> Vec<HashMap<String, FieldValue>> {
        let Some(table) = self.log.table(message) else { return Vec::new() };
        (0..table.len())
            .map(|i| table.columns.iter().filter_map(|c| Some((c.name.clone(), value(&c.data, i)?))).collect())
            .collect()
    }
}

fn value(data: &ColumnData, i: usize) -> Option<FieldValue> {
    if let ColumnData::FixedList { size, values } = data {
        let items: Vec<String> = (i * size..(i + 1) * size).filter_map(|j| values.get_f64(j)).map(|v| v.to_string()).collect();
        return Some(FieldValue::Text(format!("[{}]", items.join(", "))));
    }
    data.get_f64(i).map(FieldValue::Number).or_else(|| data.get_str(i).map(|s| FieldValue::Text(s.to_string())))
}

pub fn parse_index(path: &Path) -> Result<ParsedLog, String> {
    let log = Log::open(path, &ReadOptions::default()).map_err(|e| e.to_string())?;
    let (start_us, end_us) = log.time_range_us().unwrap_or((0, 0));
    Ok(ParsedLog { log, start_us, end_us })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A FMT record declaring `id` as `name` with `format` / `columns`.
    fn fmt(id: u8, name: &str, format: &str, columns: &str, len: u8) -> Vec<u8> {
        let mut body = vec![0u8; 86];
        body[0] = id;
        body[1] = len;
        body[2..2 + name.len()].copy_from_slice(name.as_bytes());
        body[6..6 + format.len()].copy_from_slice(format.as_bytes());
        body[22..22 + columns.len()].copy_from_slice(columns.as_bytes());
        [vec![0xA3, 0x95, 0x80], body].concat()
    }

    fn pos(t: u64, lat: i32, lng: i32) -> Vec<u8> {
        [vec![0xA3, 0x95, 0x40], t.to_le_bytes().to_vec(), lat.to_le_bytes().to_vec(), lng.to_le_bytes().to_vec()].concat()
    }

    #[test]
    fn scales_lat_lon_and_ignores_a_stray_timestamp() {
        let mut bytes = fmt(0x40, "POS", "QLL", "TimeUS,Lat,Lng", 19);
        for k in 0..50u64 {
            bytes.extend(pos(1_000_000 + k * 100_000, 340_000_000, -1_180_000_000));
        }
        // One record whose TimeUS took a flipped high bit.
        bytes.extend(pos(1_000_000 + 50 * 100_000 + (1 << 40), 340_000_000, -1_180_000_000));
        for k in 51..100u64 {
            bytes.extend(pos(1_000_000 + k * 100_000, 340_000_000, -1_180_000_000));
        }
        let dir = std::env::temp_dir().join(format!("aetherius-parser-{}.bin", std::process::id()));
        std::fs::write(&dir, &bytes).unwrap();
        let parsed = parse_index(&dir).unwrap();
        std::fs::remove_file(&dir).ok();

        assert_eq!(parsed.start_us, 1_000_000);
        assert_eq!(parsed.end_us, 1_000_000 + 99 * 100_000);
        let first = &parsed.records("POS")[0];
        assert_eq!(first["Lat"].as_f64(), Some(34.0));
        assert_eq!(first["Lng"].as_f64(), Some(-118.0));
    }
}
