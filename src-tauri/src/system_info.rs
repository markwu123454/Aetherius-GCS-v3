//! The machine the app is running on, for bug reports. Only what helps
//! reproduce an issue — OS, edition, build, architecture — nothing that
//! identifies the machine or its user.

use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemInfo {
    /// e.g. "Windows 11 (10.0.26200)".
    os: String,
    /// The CPU architecture the app was built for, e.g. "x86_64".
    arch: &'static str,
}

#[tauri::command]
pub fn system_info() -> SystemInfo {
    let info = os_info::get();
    let version = info.version();
    let name = match (info.os_type(), version) {
        // Windows 11 still reports itself as version 10.0 — the build number
        // is the only reliable tell (22000 and up is 11, per Microsoft).
        // `edition()` isn't used: it appends Windows' raw edition ID (e.g.
        // "CoreCountrySpecific"), which reads as noise in a report.
        (os_info::Type::Windows, os_info::Version::Semantic(_, _, build)) => {
            if *build >= 22000 { "Windows 11" } else { "Windows 10" }.to_string()
        }
        (os_type, _) => os_type.to_string(),
    };
    SystemInfo {os: format!("{name} ({version})"), arch: std::env::consts::ARCH}
}

#[cfg(test)]
mod tests {
    #[test]
    fn reports_something_readable() {
        let info = super::system_info();
        println!("os = {} | arch = {}", info.os, info.arch);
        assert!(!info.os.is_empty());
    }
}
