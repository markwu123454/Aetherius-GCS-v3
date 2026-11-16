//! Turns a command line into a catalog command plus its arguments, keyed
//! the way the app expects them in `Request::args`.

use serde_json::{Map, Value};

use crate::catalog::{self, CommandDef};

#[derive(Clone, Debug)]
pub struct Globals {
    pub json: bool,
    pub timeout_secs: u64,
    pub no_wait: bool,
    pub quiet: bool,
    pub help: bool,
    pub version: bool,
}

impl Default for Globals {
    fn default() -> Self {
        Globals { json: false, timeout_secs: 600, no_wait: false, quiet: false, help: false, version: false }
    }
}

#[derive(Clone, Debug)]
pub struct Parsed {
    /// `None` when no command was given.
    pub command: Option<&'static CommandDef>,
    pub args: Map<String, Value>,
    pub globals: Globals,
}

/// `30s`, `5m`, `1h`, or plain seconds.
pub fn parse_duration(text: &str) -> Result<u64, String> {
    let text = text.trim();
    let (number, scale) = match text.chars().last() {
        Some('s') => (&text[..text.len() - 1], 1),
        Some('m') => (&text[..text.len() - 1], 60),
        Some('h') => (&text[..text.len() - 1], 3600),
        _ => (text, 1),
    };
    number
        .parse::<f64>()
        .ok()
        .filter(|n| *n >= 0.0)
        .map(|n| (n * scale as f64).round() as u64)
        .ok_or_else(|| format!("not a duration: {text} (use 30s, 5m or 1h)"))
}

fn typed(kind: &str, raw: &str, what: &str) -> Result<Value, String> {
    match kind {
        "integer" => raw.parse::<i64>().map(Value::from).map_err(|_| format!("{what} needs a whole number, got {raw}")),
        "number" => raw
            .parse::<f64>()
            .ok()
            .filter(|n| n.is_finite())
            .map(Value::from)
            .ok_or_else(|| format!("{what} needs a number, got {raw}")),
        _ => Ok(Value::String(raw.to_string())),
    }
}

pub fn parse(argv: &[String]) -> Result<Parsed, String> {
    let mut globals = Globals::default();
    let mut rest: Vec<String> = Vec::new();

    let mut i = 0;
    while i < argv.len() {
        let token = &argv[i];
        match token.as_str() {
            "--json" => globals.json = true,
            "--no-wait" => globals.no_wait = true,
            "--quiet" => globals.quiet = true,
            "--help" | "-h" => globals.help = true,
            "--version" | "-V" => globals.version = true,
            "--timeout" => {
                i += 1;
                let value = argv.get(i).ok_or("--timeout needs a value")?;
                globals.timeout_secs = parse_duration(value)?;
            }
            t if t.starts_with("--timeout=") => globals.timeout_secs = parse_duration(&t["--timeout=".len()..])?,
            _ => rest.push(token.clone()),
        }
        i += 1;
    }

    let words: Vec<&String> = rest.iter().filter(|t| !t.starts_with("--")).collect();
    if words.is_empty() {
        if let Some(option) = rest.first() {
            return Err(format!("unknown option {option}"));
        }
        return Ok(Parsed { command: None, args: Map::new(), globals });
    }

    let two = words.get(1).map(|second| format!("{} {}", words[0], second));
    let (command, consumed) = match two.as_deref().and_then(catalog::find) {
        Some(def) => (def, 2),
        None => match catalog::find(words[0]) {
            Some(def) => (def, 1),
            None => {
                let group: Vec<&str> =
                    catalog::commands().iter().filter(|c| c.name.split(' ').next() == Some(words[0].as_str())).map(|c| c.name).collect();
                return Err(if group.is_empty() {
                    format!("unknown command '{}' (see aetherius-cli help)", words[0])
                } else {
                    format!("'{}' needs a subcommand: {}", words[0], group.join(", "))
                });
            }
        },
    };

    // Drop the command words themselves (they're the first `consumed`
    // non-option tokens), keeping everything else in order.
    let mut skipped = 0;
    let mut tokens: Vec<String> = Vec::new();
    for token in rest {
        if skipped < consumed && !token.starts_with("--") {
            skipped += 1;
            continue;
        }
        tokens.push(token);
    }

    let mut args = Map::new();
    let mut positionals: Vec<String> = Vec::new();
    let mut i = 0;
    while i < tokens.len() {
        let token = &tokens[i];
        if let Some(stripped) = token.strip_prefix("--") {
            let (name, attached) = match stripped.split_once('=') {
                Some((n, v)) => (n, Some(v.to_string())),
                None => (stripped, None),
            };
            let flag = format!("--{name}");
            let option = command
                .options
                .iter()
                .find(|o| o.flag == flag)
                .ok_or_else(|| format!("{} doesn't take {flag} (see aetherius-cli help {})", command.name, command.name))?;
            match option.value {
                None => {
                    if attached.is_some() {
                        return Err(format!("{flag} doesn't take a value"));
                    }
                    args.insert(option.key.to_string(), Value::Bool(true));
                }
                Some(value_name) => {
                    let raw = match attached {
                        Some(v) => v,
                        None => {
                            i += 1;
                            tokens.get(i).cloned().ok_or_else(|| format!("{flag} needs {value_name}"))?
                        }
                    };
                    if option.repeat {
                        let list = args.entry(option.key.to_string()).or_insert_with(|| Value::Array(Vec::new()));
                        if let Value::Array(items) = list {
                            for part in raw.split(',').filter(|p| !p.is_empty()) {
                                items.push(typed(option.kind, part, &flag)?);
                            }
                        }
                    } else {
                        args.insert(option.key.to_string(), typed(option.kind, &raw, &flag)?);
                    }
                }
            }
        } else {
            positionals.push(token.clone());
        }
        i += 1;
    }

    let mut positionals = positionals.into_iter();
    for def in &command.args {
        if def.repeat {
            let all: Vec<Value> = positionals.by_ref().map(Value::String).collect();
            if def.required && all.is_empty() {
                return Err(format!("{} needs {}", command.name, def.name));
            }
            if !all.is_empty() {
                args.insert(def.key.to_string(), Value::Array(all));
            }
        } else if let Some(value) = positionals.next() {
            args.insert(def.key.to_string(), typed(def.kind, &value, def.name)?);
        } else if def.required {
            return Err(format!("{} needs {} (synopsis: {})", command.name, def.name, command.synopsis.replace('\n', " | ")));
        }
    }
    if let Some(extra) = positionals.next() {
        return Err(format!("{} got an extra argument: {extra}", command.name));
    }

    if command.name == "script push" {
        let has_files = args.get("files").is_some();
        let watching = args.get("watch").is_some();
        if has_files == watching {
            return Err("script push needs either LOCAL files or --watch DIR".to_string());
        }
    }
    if command.name == "logs export" && args.get("out").is_none() {
        return Err("logs export needs --out FILE".to_string());
    }
    if command.name == "logs eval" {
        let modes = ["stats", "series", "fft"].iter().filter(|k| args.get(**k).is_some()).count();
        if modes > 1 {
            return Err("logs eval takes one of --stats, --series or --fft".to_string());
        }
    }

    Ok(Parsed { command: Some(command), args, globals })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(line: &str) -> Result<Parsed, String> {
        parse(&line.split_whitespace().map(String::from).collect::<Vec<_>>())
    }

    #[test]
    fn two_word_commands_and_options() {
        let parsed = p("params set A=1 B=2 --dry-run --json").unwrap();
        assert_eq!(parsed.command.unwrap().name, "params set");
        assert_eq!(parsed.args["assignments"], serde_json::json!(["A=1", "B=2"]));
        assert_eq!(parsed.args["dryRun"], Value::Bool(true));
        assert!(parsed.globals.json);
    }

    #[test]
    fn typed_and_repeated_options() {
        let parsed = p("logs fft 42 IMU.GyrX --peaks 5 --from 2:10 --timeout 30s").unwrap();
        assert_eq!(parsed.args["peaks"], Value::from(5));
        assert_eq!(parsed.args["from"], Value::from("2:10"));
        assert_eq!(parsed.globals.timeout_secs, 30);
        let parsed = p("params apply x.param --only ATC_*,INS_* --only MOT_*").unwrap();
        assert_eq!(parsed.args["only"], serde_json::json!(["ATC_*", "INS_*", "MOT_*"]));
    }

    #[test]
    fn errors_are_specific() {
        assert!(p("params").unwrap_err().contains("subcommand"));
        assert!(p("nope").unwrap_err().contains("unknown command"));
        assert!(p("params set").unwrap_err().contains("needs"));
        assert!(p("status extra").unwrap_err().contains("extra"));
        assert!(p("status --bogus").unwrap_err().contains("doesn't take"));
        assert!(p("script push").unwrap_err().contains("--watch"));
        assert!(p("logs fft 42 X --peaks many").unwrap_err().contains("whole number"));
    }

    #[test]
    fn no_command_is_help() {
        assert!(p("").unwrap().command.is_none());
        assert!(p("--version").unwrap().globals.version);
    }
}
