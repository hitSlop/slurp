//! How numbers are shown in report metrics and tables.
//!
//! Without options a number reads naturally: thousands separators, no pointless `.0`, at most two decimals (three significant
//! digits below 1). A metric or a table column can add `decimals`, `prefix`, `suffix` and `compact`:
//!
//! ```yaml
//! decimals: 1
//! prefix: "$"
//! suffix: "%"      # the value is shown as is: 46 becomes 46%
//! compact: true    # 1234567 becomes 1.2M
//! ```
use serde_json::{Number, Value};

#[derive(Debug, Clone, Default, PartialEq)]
pub struct NumberFormat {
    pub decimals: Option<usize>,
    pub prefix: String,
    pub suffix: String,
    pub compact: bool,
}

impl NumberFormat {
    /// Read the format keys from a metric block, or from one entry of a table's `formats:` map.
    ///
    /// # Errors
    /// Returns a message naming the key that has a wrong type or value.
    pub fn from_spec(spec: &Value) -> Result<Self, String> {
        let mut format = Self::default();
        if let Some(value) = spec.get("decimals") {
            match value.as_u64() {
                Some(n) if n <= 10 => format.decimals = Some(n as usize),
                _ => return Err("`decimals` must be a whole number from 0 to 10".into()),
            }
        }
        for (key, slot) in [
            ("prefix", &mut format.prefix),
            ("suffix", &mut format.suffix),
        ] {
            if let Some(value) = spec.get(key) {
                match value.as_str() {
                    Some(text) if text.chars().count() <= 8 => *slot = text.to_owned(),
                    _ => {
                        return Err(format!(
                            "`{key}` must be a short piece of text such as \"$\""
                        ));
                    }
                }
            }
        }
        if let Some(value) = spec.get("compact") {
            format.compact = value.as_bool().ok_or("`compact` must be true or false")?;
        }
        Ok(format)
    }

    /// Show a JSON value: numbers are formatted, everything else is shown as text. `group_from` is the size from which
    /// whole numbers get thousands separators when no explicit format asks for them (small numbers are often years or counters).
    pub fn show(&self, value: &Value, group_from: f64) -> String {
        match value {
            Value::Number(n) => self.number(n, group_from),
            Value::String(s) => s.clone(),
            Value::Null => "—".into(),
            Value::Bool(b) => b.to_string(),
            other => other.to_string(),
        }
    }

    fn number(&self, n: &Number, group_from: f64) -> String {
        let text = if self.compact {
            self.compact_text(n.as_f64().unwrap_or(0.0))
        } else if let Some(decimals) = self.decimals {
            group(&fixed(n.as_f64().unwrap_or(0.0), decimals), 0.0)
        } else if n.is_i64() || n.is_u64() {
            // Integers keep every digit (they may be larger than a float can hold exactly).
            group(&n.to_string(), group_from)
        } else {
            group(&natural(n.as_f64().unwrap_or(0.0)), group_from)
        };
        // The minus sign goes in front of the prefix: -$5, not $-5.
        let (sign, body) = text
            .strip_prefix('-')
            .map_or(("", text.as_str()), |rest| ("-", rest));
        format!("{sign}{}{body}{}", self.prefix, self.suffix)
    }
    fn compact_text(&self, x: f64) -> String {
        let decimals = self.decimals.unwrap_or(1);
        let (scaled, unit) = match x.abs() {
            // Beyond trillions a suffix stops being readable; show the whole number instead.
            a if a >= 1e15 => return group(&natural(x), 0.0),
            a if a >= 1e12 => (x / 1e12, "T"),
            a if a >= 1e9 => (x / 1e9, "B"),
            a if a >= 1e6 => (x / 1e6, "M"),
            a if a >= 1e3 => (x / 1e3, "K"),
            _ => (x, ""),
        };
        format!("{}{unit}", trim_zeros(&fixed(scaled, decimals)))
    }
}

/// `x` with exactly `decimals` decimals, rounding halves away from zero (Rust's own formatting rounds 2.5 to 2).
fn fixed(x: f64, decimals: usize) -> String {
    let factor = 10f64.powi(decimals as i32);
    format!("{:.decimals$}", (x * factor).round() / factor)
}
/// Two decimals at most, three significant digits for numbers below one, no trailing zeros.
fn natural(x: f64) -> String {
    if !x.is_finite() {
        return "—".into();
    }
    if x == x.trunc() {
        return format!("{x:.0}");
    }
    let places = if x.abs() >= 1.0 {
        2
    } else {
        // 0.000123 keeps its 3 significant digits: 4 + the leading zeros after the point.
        (2 - x.abs().log10().floor() as i32).clamp(2, 12) as usize
    };
    trim_zeros(&format!("{x:.places$}"))
}
fn trim_zeros(text: &str) -> String {
    if text.contains('.') {
        text.trim_end_matches('0').trim_end_matches('.').to_owned()
    } else {
        text.to_owned()
    }
}
/// Put commas into the whole-number part of `text` when it has at least as many as `from` (0 groups always).
fn group(text: &str, from: f64) -> String {
    let (sign, rest) = text.strip_prefix('-').map_or(("", text), |r| ("-", r));
    let (whole, fraction) = rest.split_once('.').map_or((rest, ""), |(w, f)| (w, f));
    if !whole.chars().all(|c| c.is_ascii_digit()) || whole.parse::<f64>().unwrap_or(0.0) < from {
        return text.to_owned();
    }
    let mut out = String::new();
    for (i, c) in whole.chars().enumerate() {
        if i > 0 && (whole.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    if fraction.is_empty() {
        format!("{sign}{out}")
    } else {
        format!("{sign}{out}.{fraction}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn show(spec: Value, value: Value, group_from: f64) -> String {
        NumberFormat::from_spec(&spec)
            .unwrap()
            .show(&value, group_from)
    }

    #[test]
    fn numbers_read_naturally_without_options() {
        assert_eq!(show(json!({}), json!(46.0), 1000.0), "46");
        assert_eq!(show(json!({}), json!(1234567.891), 1000.0), "1,234,567.89");
        assert_eq!(show(json!({}), json!(0.000123), 1000.0), "0.000123");
        assert_eq!(show(json!({}), json!(0.3333333), 1000.0), "0.333");
        assert_eq!(show(json!({}), json!(-42), 1000.0), "-42");
        assert_eq!(show(json!({}), json!(5379), 1000.0), "5,379");
        assert_eq!(show(json!({}), json!(Value::Null), 1000.0), "—");
        assert_eq!(show(json!({}), json!("text"), 1000.0), "text");
    }

    #[test]
    fn table_cells_leave_years_and_small_counters_alone() {
        assert_eq!(show(json!({}), json!(2026), 10_000.0), "2026");
        assert_eq!(show(json!({}), json!(123456), 10_000.0), "123,456");
    }

    #[test]
    fn integers_keep_every_digit() {
        let huge: Value = serde_json::from_str("12345678901234567890").unwrap();
        assert_eq!(show(json!({}), huge, 1000.0), "12,345,678,901,234,567,890");
    }

    #[test]
    fn options_control_decimals_prefix_suffix_and_compact() {
        assert_eq!(
            show(json!({"decimals": 1, "suffix": "%"}), json!(46.04), 1000.0),
            "46.0%"
        );
        assert_eq!(
            show(json!({"prefix": "$", "decimals": 2}), json!(1234.5), 1000.0),
            "$1,234.50"
        );
        assert_eq!(show(json!({"prefix": "$"}), json!(-5), 1000.0), "-$5");
        assert_eq!(
            show(json!({"compact": true}), json!(1234567), 1000.0),
            "1.2M"
        );
        assert_eq!(
            show(
                json!({"compact": true, "decimals": 0}),
                json!(2_500_000_000.0),
                1000.0
            ),
            "3B"
        );
        assert_eq!(show(json!({"compact": true}), json!(950), 1000.0), "950");
    }

    #[test]
    fn bad_options_say_which_key_is_wrong() {
        assert!(
            NumberFormat::from_spec(&json!({"decimals": 99}))
                .unwrap_err()
                .contains("decimals")
        );
        assert!(
            NumberFormat::from_spec(&json!({"prefix": 5}))
                .unwrap_err()
                .contains("prefix")
        );
        assert!(
            NumberFormat::from_spec(&json!({"compact": "yes"}))
                .unwrap_err()
                .contains("compact")
        );
    }
}
