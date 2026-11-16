//! `--add-to-path` and `--remove-from-path`, which the Windows installer runs
//! so `aetherius-cli` works from any new terminal. Both act on the folder
//! holding this program and on the user's PATH (HKCU\Environment).
//!
//! The installer calls the CLI rather than editing PATH itself because NSIS
//! strings stop at 1024 characters, shorter than many PATHs; reading one
//! that long cuts it off, and writing it back would lose the rest.

/// `path` with `dir` added at the end, or `None` when it's already there.
/// A trailing `;` stays trailing, so removing `dir` again gives back exactly
/// the original text.
pub fn with_dir(path: &str, dir: &str) -> Option<String> {
    if path.split(';').any(|entry| same_dir(entry, dir)) {
        return None;
    }
    Some(match path {
        "" => dir.to_string(),
        _ if path.ends_with(';') => format!("{path}{dir};"),
        _ => format!("{path};{dir}"),
    })
}

/// `path` without any entry for `dir`, or `None` when it has none. Every
/// other entry is kept as written, empty ones included.
pub fn without_dir(path: &str, dir: &str) -> Option<String> {
    let entries: Vec<&str> = path.split(';').collect();
    let kept: Vec<&str> = entries.iter().copied().filter(|entry| !same_dir(entry, dir)).collect();
    (kept.len() != entries.len()).then(|| kept.join(";"))
}

fn same_dir(entry: &str, dir: &str) -> bool {
    let normal = |s: &str| s.trim().trim_matches('"').trim_end_matches(['\\', '/']).to_lowercase();
    !entry.trim().is_empty() && normal(entry) == normal(dir)
}

/// Runs `--add-to-path` (`add`) or `--remove-from-path`; the exit code.
pub fn run(add: bool) -> i32 {
    match edit(add) {
        Ok(message) => {
            println!("{message}");
            0
        }
        Err(message) => {
            eprintln!("error: {message}");
            1
        }
    }
}

#[cfg(windows)]
fn edit(add: bool) -> Result<String, String> {
    let exe = std::env::current_exe().map_err(|e| format!("couldn't find this program's folder: {e}"))?;
    let dir = exe
        .parent()
        .and_then(|d| d.to_str())
        .ok_or("this program's folder has no usable name")?
        .to_string();

    let env = registry::Environment::open()?;
    let (current, kind) = env.path()?.unwrap_or((String::new(), registry::REG_EXPAND_SZ));
    let next = if add { with_dir(&current, &dir) } else { without_dir(&current, &dir) };
    let Some(next) = next else {
        return Ok(format!("{dir} is {} PATH", if add { "already on" } else { "not on" }));
    };
    if next.is_empty() {
        env.delete_path()?;
    } else {
        env.set_path(&next, kind)?;
    }
    registry::announce();
    Ok(if add { format!("added {dir} to PATH") } else { format!("removed {dir} from PATH") })
}

#[cfg(not(windows))]
fn edit(_add: bool) -> Result<String, String> {
    Err("only the Windows installer uses this".to_string())
}

#[cfg(windows)]
mod registry {
    use windows_sys::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_MORE_DATA, ERROR_SUCCESS};
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegDeleteValueW, RegOpenKeyExW, RegQueryValueExW, RegSetValueExW, HKEY, HKEY_CURRENT_USER,
        KEY_QUERY_VALUE, KEY_SET_VALUE, REG_SZ,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        SendMessageTimeoutW, HWND_BROADCAST, SMTO_ABORTIFHUNG, WM_SETTINGCHANGE,
    };

    pub use windows_sys::Win32::System::Registry::REG_EXPAND_SZ;

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    pub struct Environment(HKEY);

    impl Environment {
        pub fn open() -> Result<Self, String> {
            let mut key: HKEY = std::ptr::null_mut();
            let status = unsafe {
                RegOpenKeyExW(HKEY_CURRENT_USER, wide("Environment").as_ptr(), 0, KEY_QUERY_VALUE | KEY_SET_VALUE, &mut key)
            };
            if status != ERROR_SUCCESS {
                return Err(format!("couldn't open HKCU\\Environment (error {status})"));
            }
            Ok(Self(key))
        }

        /// The Path value as stored (`%VARS%` unexpanded) and its type, or
        /// `None` when there isn't one.
        pub fn path(&self) -> Result<Option<(String, u32)>, String> {
            let name = wide("Path");
            let mut size = 0u32;
            let mut kind = 0u32;
            let status = unsafe {
                RegQueryValueExW(self.0, name.as_ptr(), std::ptr::null(), &mut kind, std::ptr::null_mut(), &mut size)
            };
            if status == ERROR_FILE_NOT_FOUND {
                return Ok(None);
            }
            // Sized again on each try, in case something grows PATH between
            // the size query and the read.
            for _ in 0..3 {
                if status != ERROR_SUCCESS && status != ERROR_MORE_DATA {
                    break;
                }
                let mut buf = vec![0u16; size as usize / 2 + 64];
                let mut bytes = (buf.len() * 2) as u32;
                let status = unsafe {
                    RegQueryValueExW(self.0, name.as_ptr(), std::ptr::null(), &mut kind, buf.as_mut_ptr().cast(), &mut bytes)
                };
                if status == ERROR_MORE_DATA {
                    size = bytes;
                    continue;
                }
                if status != ERROR_SUCCESS {
                    return Err(format!("couldn't read PATH (error {status})"));
                }
                if kind != REG_SZ && kind != REG_EXPAND_SZ {
                    return Err("PATH isn't a text value, so it was left alone".to_string());
                }
                let text = &buf[..(bytes as usize / 2).min(buf.len())];
                let end = text.iter().position(|&c| c == 0).unwrap_or(text.len());
                let path = String::from_utf16(&text[..end]).map_err(|_| "PATH isn't valid text, so it was left alone")?;
                return Ok(Some((path, kind)));
            }
            Err(format!("couldn't read PATH (error {status})"))
        }

        pub fn set_path(&self, value: &str, kind: u32) -> Result<(), String> {
            let data = wide(value);
            let status = unsafe {
                RegSetValueExW(self.0, wide("Path").as_ptr(), 0, kind, data.as_ptr().cast(), (data.len() * 2) as u32)
            };
            if status != ERROR_SUCCESS {
                return Err(format!("couldn't write PATH (error {status})"));
            }
            Ok(())
        }

        pub fn delete_path(&self) -> Result<(), String> {
            let status = unsafe { RegDeleteValueW(self.0, wide("Path").as_ptr()) };
            if status != ERROR_SUCCESS && status != ERROR_FILE_NOT_FOUND {
                return Err(format!("couldn't remove PATH (error {status})"));
            }
            Ok(())
        }
    }

    impl Drop for Environment {
        fn drop(&mut self) {
            unsafe {
                RegCloseKey(self.0);
            }
        }
    }

    /// Tells running programs the environment changed, so terminals opened
    /// from Explorer or the Start menu afterwards get the new PATH.
    pub fn announce() {
        let area = wide("Environment");
        unsafe {
            SendMessageTimeoutW(
                HWND_BROADCAST,
                WM_SETTINGCHANGE,
                0,
                area.as_ptr() as isize,
                SMTO_ABORTIFHUNG,
                5000,
                std::ptr::null_mut(),
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DIR: &str = r"C:\Users\pat\AppData\Local\Aetherius GCS";

    #[test]
    fn adds_to_the_end() {
        assert_eq!(with_dir(r"C:\a;C:\b", DIR).unwrap(), format!(r"C:\a;C:\b;{DIR}"));
        assert_eq!(with_dir("", DIR).unwrap(), DIR);
    }

    #[test]
    fn keeps_a_trailing_semicolon() {
        assert_eq!(with_dir(r"C:\a;", DIR).unwrap(), format!(r"C:\a;{DIR};"));
    }

    #[test]
    fn skips_a_dir_already_there() {
        assert!(with_dir(&format!(r"C:\a;{DIR}"), DIR).is_none());
        assert!(with_dir(&format!(r#"C:\a;"{}\""#, DIR.to_uppercase()), DIR).is_none());
    }

    #[test]
    fn removes_every_entry_for_the_dir() {
        let path = format!(r"C:\a;{DIR};C:\b;{}\", DIR.to_lowercase());
        assert_eq!(without_dir(&path, DIR).unwrap(), r"C:\a;C:\b");
        assert!(without_dir(r"C:\a;C:\b", DIR).is_none());
    }

    #[test]
    fn add_then_remove_gives_back_the_original() {
        for original in ["", r"C:\a", r"C:\a;", r"%USERPROFILE%\bin;;C:\b", r"C:\a;C:\b;"] {
            let added = with_dir(original, DIR).unwrap();
            assert_eq!(without_dir(&added, DIR).unwrap(), original, "from {original:?}");
        }
    }
}
