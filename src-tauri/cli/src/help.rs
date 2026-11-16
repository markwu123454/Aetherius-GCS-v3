//! `help`, `help COMMAND`, `help errors` and `help --json`, all generated
//! from the catalog.

use serde_json::{json, Value};

use aetherius_cli::catalog::{self, CommandDef, GLOBAL_OPTIONS};
use aetherius_cli::protocol::{ERRORS, PROTOCOL};
use aetherius_cli::shape;

fn category_tag(def: &CommandDef) -> String {
    let base = match def.category {
        catalog::Category::Always => "always".to_string(),
        other => other.key().to_string(),
    };
    if def.while_armed {
        format!("{base}, armed")
    } else {
        base
    }
}

pub fn overview() -> String {
    let mut out = String::from("Use a running Aetherius GCS from a terminal.\n\n");
    let rows: Vec<(String, &str, String)> = catalog::commands()
        .iter()
        .flat_map(|def| {
            def.synopsis.lines().map(move |line| (short_synopsis(line), def.summary, category_tag(def))).take(1)
        })
        .collect();
    let width = rows.iter().map(|(s, _, _)| s.chars().count()).max().unwrap_or(0) + 2;
    let summary_width = rows.iter().map(|(_, s, _)| s.chars().count()).max().unwrap_or(0) + 2;
    for (synopsis, summary, tag) in rows {
        out.push_str(&format!("{synopsis:<width$}{summary:<summary_width$}{tag}\n"));
    }
    out.push_str("\noptions   --json  --timeout DURATION  --no-wait  --quiet  --version\n");
    out.push_str("more      help COMMAND · help errors · help --json\n");
    out
}

/// The synopsis with its bracketed options dropped, for the overview list.
fn short_synopsis(line: &str) -> String {
    let mut out = String::new();
    let mut depth = 0;
    for c in line.chars() {
        match c {
            '[' => depth += 1,
            ']' => depth -= 1,
            _ if depth == 0 => out.push(c),
            _ => {}
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn wrap(text: &str, width: usize, indent: &str) -> String {
    let mut out = String::new();
    let mut line = String::new();
    for word in text.split_whitespace() {
        if !line.is_empty() && line.chars().count() + 1 + word.chars().count() > width {
            out.push_str(indent);
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
        out.push_str(indent);
        out.push_str(&line);
        out.push('\n');
    }
    out
}

pub fn command(def: &CommandDef) -> String {
    let mut out = String::new();
    for line in def.synopsis.lines() {
        out.push_str(line);
        out.push('\n');
    }
    out.push('\n');
    out.push_str(&wrap(def.description, 78, ""));
    out.push('\n');

    let category = if def.while_armed {
        format!("{} · while armed applies", def.category.label())
    } else {
        def.category.label().to_string()
    };
    out.push_str(&format!("{:<12}{category}\n", "category"));

    let mut first = true;
    for arg in &def.args {
        let name = if arg.repeat { format!("{}...", arg.name) } else { arg.name.to_string() };
        let label = if first { "arguments" } else { "" };
        first = false;
        let optional = if arg.required { "" } else { " (optional)" };
        out.push_str(&format!("{label:<12}{name:<24}{}{optional}\n", arg.help));
    }
    let mut first = true;
    for option in &def.options {
        let name = match option.value {
            Some(v) => format!("{} {v}", option.flag),
            None => option.flag.to_string(),
        };
        let label = if first { "options" } else { "" };
        first = false;
        out.push_str(&format!("{label:<12}{name:<24}{}\n", option.help));
    }
    if !def.errors.is_empty() {
        out.push_str(&format!("{:<12}{}\n", "errors", def.errors.join("  ")));
    }

    if !def.example.is_empty() {
        out.push_str("\nexample\n");
        for line in def.example.lines() {
            out.push_str("  ");
            out.push_str(line);
            out.push('\n');
        }
    }

    if let Ok(parsed) = shape::parse(def.data) {
        if !matches!(parsed, shape::Shape::Prim(_)) {
            out.push_str("\ndata (--json)\n");
            for (name, desc) in shape::help_lines(&parsed) {
                out.push_str(&format!("  {name:<16}{desc}\n"));
            }
        }
    }
    if let Some(item) = def.item.and_then(|i| shape::parse(i).ok()) {
        out.push_str("\nitem (--json)\n");
        for (name, desc) in shape::help_lines(&item) {
            out.push_str(&format!("  {name:<16}{desc}\n"));
        }
    }
    out
}

pub fn errors() -> String {
    let mut out = format!("{:<6}{:<18}{}\n", "exit", "code", "meaning");
    out.push_str(&format!("{:<6}{:<18}{}\n", "0", "", "done"));
    for (code, exit, meaning) in ERRORS {
        out.push_str(&format!("{exit:<6}{code:<18}{meaning}\n"));
    }
    out.push_str(&format!("{:<6}{:<18}{}\n", "130", "", "Ctrl+C"));
    out
}

pub fn command_json(def: &CommandDef) -> Value {
    json!({
        "name": def.name,
        "synopsis": def.synopsis,
        "summary": def.summary,
        "description": def.description,
        "category": def.category.key(),
        "whileArmed": def.while_armed,
        "needsVehicle": def.needs_vehicle,
        "streams": def.streams || def.item.is_some(),
        "args": def.args.iter().map(|a| json!({
            "name": a.name, "key": a.key, "type": a.kind, "required": a.required, "repeat": a.repeat, "help": a.help,
        })).collect::<Vec<_>>(),
        "options": def.options.iter().map(|o| json!({
            "name": o.flag, "key": o.key, "type": o.kind, "value": o.value, "repeat": o.repeat, "help": o.help,
        })).collect::<Vec<_>>(),
        "errors": def.errors,
        "data": shape::parse(def.data).map(|s| shape::to_json_schema(&s)).unwrap_or(json!({})),
        "item": def.item.and_then(|i| shape::parse(i).ok()).map(|s| shape::to_json_schema(&s)),
    })
}

pub fn catalog_json() -> Value {
    json!({
        "cli": env!("CARGO_PKG_VERSION"),
        "protocol": PROTOCOL,
        "globalOptions": GLOBAL_OPTIONS.iter().map(|g| json!({
            "name": g.flag, "type": g.kind, "value": g.value, "default": g.default, "help": g.help,
        })).collect::<Vec<_>>(),
        "errors": ERRORS.iter().map(|(code, exit, meaning)| json!({"code": code, "exit": exit, "meaning": meaning})).collect::<Vec<_>>(),
        "commands": catalog::commands().iter().map(command_json).collect::<Vec<_>>(),
    })
}

/// Resolves `help` topic words to a command (`["params", "set"]` →
/// `params set`), also accepting a bare group name's first command.
pub fn find_topic(words: &[String]) -> Option<&'static CommandDef> {
    let joined = words.join(" ");
    catalog::find(&joined)
}
