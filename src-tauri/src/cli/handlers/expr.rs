//! `logs eval` expressions: fields, numbers, `+ - * / ^`, parentheses and a
//! few functions, evaluated over whole series at once.

#[derive(Clone, Debug, PartialEq)]
pub enum Expr {
    Num(f64),
    Field(String),
    Neg(Box<Expr>),
    Bin(char, Box<Expr>, Box<Expr>),
    Call(String, Vec<Expr>),
}

pub const FUNCTIONS: &[(&str, usize)] = &[
    ("abs", 1),
    ("sqrt", 1),
    ("sin", 1),
    ("cos", 1),
    ("atan2", 2),
    ("hypot", 2),
    ("min", 2),
    ("max", 2),
    ("deg", 1),
    ("rad", 1),
    ("diff", 1),
    ("lpf", 2),
];

struct Parser {
    chars: Vec<char>,
    pos: usize,
}

pub fn parse(text: &str) -> Result<Expr, String> {
    let mut p = Parser { chars: text.chars().collect(), pos: 0 };
    let e = p.expr()?;
    p.ws();
    if p.pos != p.chars.len() {
        return Err(format!("unexpected '{}' at {}", p.chars[p.pos], p.pos + 1));
    }
    Ok(e)
}

impl Parser {
    fn ws(&mut self) {
        while self.chars.get(self.pos).is_some_and(|c| c.is_whitespace()) {
            self.pos += 1;
        }
    }

    fn peek(&mut self) -> Option<char> {
        self.ws();
        self.chars.get(self.pos).copied()
    }

    fn expr(&mut self) -> Result<Expr, String> {
        let mut left = self.term()?;
        while let Some(op @ ('+' | '-')) = self.peek() {
            self.pos += 1;
            left = Expr::Bin(op, Box::new(left), Box::new(self.term()?));
        }
        Ok(left)
    }

    fn term(&mut self) -> Result<Expr, String> {
        let mut left = self.power()?;
        while let Some(op @ ('*' | '/')) = self.peek() {
            self.pos += 1;
            left = Expr::Bin(op, Box::new(left), Box::new(self.power()?));
        }
        Ok(left)
    }

    fn power(&mut self) -> Result<Expr, String> {
        let base = self.unary()?;
        if self.peek() == Some('^') {
            self.pos += 1;
            return Ok(Expr::Bin('^', Box::new(base), Box::new(self.power()?)));
        }
        Ok(base)
    }

    fn unary(&mut self) -> Result<Expr, String> {
        if self.peek() == Some('-') {
            self.pos += 1;
            return Ok(Expr::Neg(Box::new(self.unary()?)));
        }
        self.atom()
    }

    fn atom(&mut self) -> Result<Expr, String> {
        match self.peek() {
            Some('(') => {
                self.pos += 1;
                let e = self.expr()?;
                if self.peek() != Some(')') {
                    return Err("missing )".to_string());
                }
                self.pos += 1;
                Ok(e)
            }
            Some(c) if c.is_ascii_digit() || c == '.' => {
                let start = self.pos;
                while self.chars.get(self.pos).is_some_and(|c| c.is_ascii_digit() || *c == '.' || *c == 'e' || *c == 'E') {
                    self.pos += 1;
                }
                let text: String = self.chars[start..self.pos].iter().collect();
                text.parse().map(Expr::Num).map_err(|_| format!("bad number {text}"))
            }
            Some(c) if c.is_alphabetic() || c == '_' => {
                let start = self.pos;
                while self.chars.get(self.pos).is_some_and(|c| c.is_alphanumeric() || matches!(c, '_' | '.' | '[' | ']')) {
                    self.pos += 1;
                }
                let name: String = self.chars[start..self.pos].iter().collect();
                if self.peek() == Some('(') {
                    self.pos += 1;
                    let mut args = Vec::new();
                    if self.peek() != Some(')') {
                        loop {
                            args.push(self.expr()?);
                            match self.peek() {
                                Some(',') => self.pos += 1,
                                _ => break,
                            }
                        }
                    }
                    if self.peek() != Some(')') {
                        return Err(format!("missing ) after {name}("));
                    }
                    self.pos += 1;
                    let lower = name.to_lowercase();
                    let (_, arity) = FUNCTIONS
                        .iter()
                        .find(|(f, _)| *f == lower)
                        .ok_or_else(|| format!("unknown function {name}"))?;
                    if args.len() != *arity {
                        return Err(format!("{lower} takes {arity} argument{}", if *arity == 1 { "" } else { "s" }));
                    }
                    return Ok(Expr::Call(lower, args));
                }
                if !name.contains('.') {
                    return Err(format!("{name} isn't a field (use MSG.Field)"));
                }
                Ok(Expr::Field(name))
            }
            Some(c) => Err(format!("unexpected '{c}'")),
            None => Err("the expression ends early".to_string()),
        }
    }
}

/// Every field the expression reads, in order of first appearance.
pub fn fields(e: &Expr, out: &mut Vec<String>) {
    match e {
        Expr::Field(name) => {
            if !out.contains(name) {
                out.push(name.clone());
            }
        }
        Expr::Neg(inner) => fields(inner, out),
        Expr::Bin(_, a, b) => {
            fields(a, out);
            fields(b, out);
        }
        Expr::Call(_, args) => args.iter().for_each(|a| fields(a, out)),
        Expr::Num(_) => {}
    }
}

/// Evaluates over `n` samples at times `t` (seconds), with each field's
/// values already lined up on `t`.
pub fn eval(e: &Expr, t: &[f64], lookup: &dyn Fn(&str) -> Vec<f64>) -> Result<Vec<f64>, String> {
    let n = t.len();
    Ok(match e {
        Expr::Num(v) => vec![*v; n],
        Expr::Field(name) => lookup(name),
        Expr::Neg(inner) => eval(inner, t, lookup)?.into_iter().map(|v| -v).collect(),
        Expr::Bin(op, a, b) => {
            let (a, b) = (eval(a, t, lookup)?, eval(b, t, lookup)?);
            a.iter()
                .zip(&b)
                .map(|(x, y)| match op {
                    '+' => x + y,
                    '-' => x - y,
                    '*' => x * y,
                    '/' => x / y,
                    _ => x.powf(*y),
                })
                .collect()
        }
        Expr::Call(name, args) => {
            let values: Vec<Vec<f64>> = args.iter().map(|a| eval(a, t, lookup)).collect::<Result<_, _>>()?;
            let one = |f: fn(f64) -> f64| values[0].iter().map(|v| f(*v)).collect::<Vec<_>>();
            let two = |f: fn(f64, f64) -> f64| values[0].iter().zip(&values[1]).map(|(a, b)| f(*a, *b)).collect::<Vec<_>>();
            match name.as_str() {
                "abs" => one(f64::abs),
                "sqrt" => one(f64::sqrt),
                "sin" => one(f64::sin),
                "cos" => one(f64::cos),
                "deg" => one(f64::to_degrees),
                "rad" => one(f64::to_radians),
                "atan2" => two(f64::atan2),
                "hypot" => two(f64::hypot),
                "min" => two(f64::min),
                "max" => two(f64::max),
                "diff" => {
                    let x = &values[0];
                    (0..n)
                        .map(|i| {
                            if i == 0 || n < 2 {
                                f64::NAN
                            } else {
                                let dt = t[i] - t[i - 1];
                                if dt > 0.0 { (x[i] - x[i - 1]) / dt } else { f64::NAN }
                            }
                        })
                        .collect()
                }
                "lpf" => {
                    let x = &values[0];
                    let cutoff = values[1].first().copied().unwrap_or(f64::NAN);
                    if !(cutoff > 0.0) {
                        return Err("lpf's cutoff must be a positive number of Hz".to_string());
                    }
                    let rc = 1.0 / (2.0 * std::f64::consts::PI * cutoff);
                    let mut out = Vec::with_capacity(n);
                    let mut y = f64::NAN;
                    for i in 0..n {
                        if !y.is_finite() {
                            y = x[i];
                        } else {
                            let dt = (t[i] - t[i - 1]).max(0.0);
                            let alpha = dt / (rc + dt);
                            if x[i].is_finite() {
                                y += alpha * (x[i] - y);
                            }
                        }
                        out.push(y);
                    }
                    out
                }
                other => return Err(format!("unknown function {other}")),
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_evaluates() {
        let e = parse("hypot(VIBE.VibeX, VIBE.VibeY) * 2 - -1").unwrap();
        let mut f = Vec::new();
        fields(&e, &mut f);
        assert_eq!(f, vec!["VIBE.VibeX", "VIBE.VibeY"]);
        let t = vec![0.0, 1.0];
        let out = eval(&e, &t, &|name| if name.ends_with('X') { vec![3.0, 0.0] } else { vec![4.0, 1.0] }).unwrap();
        assert_eq!(out, vec![11.0, 3.0]);
    }

    #[test]
    fn precedence_and_errors() {
        let t = vec![0.0];
        let v = eval(&parse("2 + 3 * 2 ^ 2").unwrap(), &t, &|_| vec![]).unwrap();
        assert_eq!(v, vec![14.0]);
        assert!(parse("nope(1)").is_err());
        assert!(parse("VibeX").is_err());
        assert!(parse("(1 + 2").is_err());
        assert!(parse("hypot(1)").is_err());
    }

    #[test]
    fn diff_is_per_second() {
        let t = vec![0.0, 0.5, 1.0];
        let out = eval(&parse("diff(A.x)").unwrap(), &t, &|_| vec![0.0, 1.0, 2.0]).unwrap();
        assert!(out[0].is_nan());
        assert_eq!(&out[1..], &[2.0, 2.0]);
    }
}
