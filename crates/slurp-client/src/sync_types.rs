//! Archive coverage and synchronization outcomes.
use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};
/// Coverage sequences use decimal strings on the wire, without JSON precision loss.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Coverage {
    #[serde(with = "sequence")]
    pub first_retained: i64,
    #[serde(with = "optional_sequence")]
    pub latest_published: Option<i64>,
    pub latest_published_at: Option<chrono::DateTime<chrono::Utc>>,
    pub retention_seconds: u64,
}
impl Coverage {
    pub fn validate(&self) -> Result<()> {
        if self.first_retained < 1 || self.latest_published.is_some_and(|n| n < 1) {
            bail!("invalid archive coverage");
        }
        Ok(())
    }
}
mod sequence {
    use serde::{Deserialize, Deserializer, Serializer};
    pub fn serialize<S: Serializer>(n: &i64, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&n.to_string())
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<i64, D::Error> {
        let value = String::deserialize(d)?;
        if value.is_empty() || !value.bytes().all(|b| b.is_ascii_digit()) {
            return Err(serde::de::Error::custom(
                "expected a decimal sequence string",
            ));
        }
        value.parse().map_err(serde::de::Error::custom)
    }
}
mod optional_sequence {
    use serde::{Deserialize, Deserializer, Serializer};
    pub fn serialize<S: Serializer>(n: &Option<i64>, s: S) -> Result<S::Ok, S::Error> {
        match n {
            Some(n) => s.serialize_some(&n.to_string()),
            None => s.serialize_none(),
        }
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Option<i64>, D::Error> {
        Option::<String>::deserialize(d)?
            .map(|v| {
                if v.is_empty() || !v.bytes().all(|b| b.is_ascii_digit()) {
                    return Err(serde::de::Error::custom(
                        "expected a decimal sequence string",
                    ));
                }
                v.parse().map_err(serde::de::Error::custom)
            })
            .transpose()
    }
}
