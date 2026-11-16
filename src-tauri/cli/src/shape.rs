//! Reply shapes, written once per command in a small TypeScript-like
//! notation and turned into both `help`'s field list and `help --json`'s
//! JSON Schema:
//!
//! ```text
//! {changes: [{name: string, from: number}], dryRun: boolean, note: string?}
//! ```
//!
//! Types are `string`, `number`, `integer`, `boolean` and `any`; `[T]` is an
//! array of T; a trailing `?` means the value may be `null`.

use serde_json::{json, Map, Value};

#[derive(Clone, Debug, PartialEq)]
pub enum Shape {
    Prim(String),
    Array(Box<Shape>),
    Object(Vec<(String, Shape)>),
    Nullable(Box<Shape>),
}

pub fn parse(text: &str) -> Result<Shape, String> {
    let mut parser = Parser { chars: text.chars().filter(|c| !c.is_whitespace()).collect(), pos: 0 };
    let shape = parser.shape()?;
    if parser.pos != parser.chars.len() {
        return Err(format!("unexpected text at {} in {text}", parser.pos));
    }
    Ok(shape)
}

struct Parser {
    chars: Vec<char>,
    pos: usize,
}

impl Parser {
    fn peek(&self) -> Option<char> {
        self.chars.get(self.pos).copied()
    }

    fn expect(&mut self, c: char) -> Result<(), String> {
        if self.peek() == Some(c) {
            self.pos += 1;
            Ok(())
        } else {
            Err(format!("expected '{c}' at {}", self.pos))
        }
    }

    fn ident(&mut self) -> Result<String, String> {
        let start = self.pos;
        while self.peek().is_some_and(|c| c.is_alphanumeric() || c == '_') {
            self.pos += 1;
        }
        if start == self.pos {
            return Err(format!("expected a name at {}", self.pos));
        }
        Ok(self.chars[start..self.pos].iter().collect())
    }

    fn shape(&mut self) -> Result<Shape, String> {
        let inner = match self.peek() {
            Some('{') => {
                self.pos += 1;
                let mut fields = Vec::new();
                if self.peek() != Some('}') {
                    loop {
                        let name = self.ident()?;
                        self.expect(':')?;
                        fields.push((name, self.shape()?));
                        if self.peek() == Some(',') {
                            self.pos += 1;
                        } else {
                            break;
                        }
                    }
                }
                self.expect('}')?;
                Shape::Object(fields)
            }
            Some('[') => {
                self.pos += 1;
                let item = self.shape()?;
                self.expect(']')?;
                Shape::Array(Box::new(item))
            }
            _ => Shape::Prim(self.ident()?),
        };
        if self.peek() == Some('?') {
            self.pos += 1;
            return Ok(Shape::Nullable(Box::new(inner)));
        }
        Ok(inner)
    }
}

pub fn to_json_schema(shape: &Shape) -> Value {
    match shape {
        Shape::Prim(name) if name == "any" => json!({}),
        Shape::Prim(name) => json!({"type": name}),
        Shape::Array(item) => json!({"type": "array", "items": to_json_schema(item)}),
        Shape::Object(fields) => {
            let mut properties = Map::new();
            for (name, field) in fields {
                properties.insert(name.clone(), to_json_schema(field));
            }
            json!({"type": "object", "properties": properties})
        }
        Shape::Nullable(inner) => {
            let mut schema = to_json_schema(inner);
            if let Some(Value::String(t)) = schema.get("type").cloned() {
                schema["type"] = json!([t, "null"]);
            }
            schema
        }
    }
}

/// One line per top-level field: the field's name (`[]` appended for an
/// array) and its type, with nested objects flattened onto the same line.
pub fn help_lines(shape: &Shape) -> Vec<(String, String)> {
    match shape {
        Shape::Object(fields) => fields
            .iter()
            .map(|(name, field)| {
                let (suffix, described) = match strip_nullable(field) {
                    (Shape::Array(item), nullable) => ("[]", describe(item) + if nullable { " · or null" } else { "" }),
                    (other, nullable) => ("", describe(other) + if nullable { " or null" } else { "" }),
                };
                (format!("{name}{suffix}"), described)
            })
            .collect(),
        other => vec![(String::new(), describe(other))],
    }
}

fn strip_nullable(shape: &Shape) -> (&Shape, bool) {
    match shape {
        Shape::Nullable(inner) => (inner, true),
        other => (other, false),
    }
}

fn describe(shape: &Shape) -> String {
    match shape {
        Shape::Prim(name) => name.clone(),
        Shape::Array(item) => format!("[{}]", describe(item)),
        Shape::Nullable(inner) => format!("{}?", describe(inner)),
        Shape::Object(fields) => fields
            .iter()
            .map(|(name, field)| format!("{name} {}", describe(field)))
            .collect::<Vec<_>>()
            .join(" · "),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_nested_shapes() {
        let shape = parse("{a: [{b: string, c: number?}], d: integer?}").unwrap();
        let schema = to_json_schema(&shape);
        assert_eq!(schema["properties"]["a"]["items"]["properties"]["c"]["type"], json!(["number", "null"]));
        assert_eq!(schema["properties"]["d"]["type"], json!(["integer", "null"]));
        let lines = help_lines(&shape);
        assert_eq!(lines[0], ("a[]".to_string(), "b string · c number?".to_string()));
    }

    #[test]
    fn rejects_garbage() {
        assert!(parse("{a string}").is_err());
        assert!(parse("{a: string").is_err());
    }
}
