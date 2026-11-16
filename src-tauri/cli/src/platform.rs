//! The few things the CLI needs from the OS: its parent processes (shown in
//! the panel), the local UTC offset (so replies show local times), and
//! Ctrl+C handling for streaming commands.

use std::sync::atomic::{AtomicBool, Ordering};

static INTERRUPTED: AtomicBool = AtomicBool::new(false);

pub fn interrupted() -> bool {
    INTERRUPTED.load(Ordering::SeqCst)
}

#[cfg(windows)]
mod imp {
    use super::INTERRUPTED;
    use std::sync::atomic::Ordering;
    use windows_sys::Win32::Foundation::{CloseHandle, BOOL, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Console::SetConsoleCtrlHandler;
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::Time::{GetTimeZoneInformation, TIME_ZONE_INFORMATION};

    pub fn process_chain() -> Vec<String> {
        let mut table: Vec<(u32, u32, String)> = Vec::new();
        unsafe {
            let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if snapshot == INVALID_HANDLE_VALUE {
                return Vec::new();
            }
            let mut entry: PROCESSENTRY32W = std::mem::zeroed();
            entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
            if Process32FirstW(snapshot, &mut entry) != 0 {
                loop {
                    let len = entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(entry.szExeFile.len());
                    let name = String::from_utf16_lossy(&entry.szExeFile[..len]);
                    table.push((entry.th32ProcessID, entry.th32ParentProcessID, name));
                    if Process32NextW(snapshot, &mut entry) == 0 {
                        break;
                    }
                }
            }
            CloseHandle(snapshot);
        }
        let mut chain = Vec::new();
        let mut pid = std::process::id();
        for _ in 0..6 {
            let Some((_, parent, name)) = table.iter().find(|(p, _, _)| *p == pid) else { break };
            chain.push(name.clone());
            if *parent == 0 || *parent == pid {
                break;
            }
            pid = *parent;
        }
        chain
    }

    pub fn utc_offset_minutes() -> i32 {
        unsafe {
            let mut info: TIME_ZONE_INFORMATION = std::mem::zeroed();
            let mode = GetTimeZoneInformation(&mut info);
            // TIME_ZONE_ID_DAYLIGHT = 2: the daylight bias applies right now.
            let bias = info.Bias + if mode == 2 { info.DaylightBias } else { info.StandardBias };
            -bias
        }
    }

    unsafe extern "system" fn on_ctrl(_ctrl_type: u32) -> BOOL {
        INTERRUPTED.store(true, Ordering::SeqCst);
        1
    }

    pub fn catch_ctrl_c() {
        unsafe {
            SetConsoleCtrlHandler(Some(on_ctrl), 1);
        }
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn process_chain() -> Vec<String> {
        vec!["aetherius-cli".to_string()]
    }

    pub fn utc_offset_minutes() -> i32 {
        0
    }

    pub fn catch_ctrl_c() {}
}

pub use imp::{catch_ctrl_c, process_chain, utc_offset_minutes};

/// `%APPDATA%`, where the app keeps its data folder.
pub fn app_data_dir() -> Option<std::path::PathBuf> {
    std::env::var_os("APPDATA").map(std::path::PathBuf::from)
}
