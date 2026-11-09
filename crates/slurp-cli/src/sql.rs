//! Shared SQL token boundaries; comments and string literals are never code.
use std::ops::Range;

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Kind {
    Identifier,
    QuotedIdentifier,
    Parameter,
}
#[derive(Debug)]
pub(crate) struct Token {
    pub kind: Kind,
    pub range: Range<usize>,
}

pub(crate) fn tokens(sql: &str) -> Vec<Token> {
    let bytes = sql.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        let start = i;
        if sql[i..].starts_with("--") {
            i += sql[i..].find('\n').unwrap_or(sql.len() - i);
        } else if sql[i..].starts_with("/*") {
            i += 2;
            let mut depth = 1;
            while i < bytes.len() && depth > 0 {
                if sql[i..].starts_with("/*") {
                    depth += 1;
                    i += 2;
                } else if sql[i..].starts_with("*/") {
                    depth -= 1;
                    i += 2;
                } else {
                    i += sql[i..].chars().next().map_or(1, char::len_utf8);
                }
            }
        } else if bytes[i] == b'\'' || bytes[i] == b'"' {
            let quote = bytes[i];
            i += 1;
            while i < bytes.len() {
                if bytes[i] == quote {
                    i += 1;
                    if bytes.get(i) == Some(&quote) {
                        i += 1;
                    } else {
                        break;
                    }
                } else {
                    i += 1;
                }
            }
            if quote == b'"' {
                out.push(Token {
                    kind: Kind::QuotedIdentifier,
                    range: start..i,
                });
            }
        } else if bytes[i] == b'$' {
            i += 1;
            while bytes
                .get(i)
                .is_some_and(|c| c.is_ascii_alphanumeric() || *c == b'_')
            {
                i += 1;
            }
            if bytes.get(i) == Some(&b'$') && !bytes.get(start + 1).is_some_and(u8::is_ascii_digit)
            {
                i += 1;
                let tag = &sql[start..i];
                i += sql[i..]
                    .find(tag)
                    .map_or(sql.len() - i, |end| end + tag.len());
            } else {
                out.push(Token {
                    kind: Kind::Parameter,
                    range: start..i,
                });
            }
        } else if bytes[i].is_ascii_alphabetic() || bytes[i] == b'_' {
            i += 1;
            while bytes
                .get(i)
                .is_some_and(|c| c.is_ascii_alphanumeric() || *c == b'_')
            {
                i += 1;
            }
            out.push(Token {
                kind: Kind::Identifier,
                range: start..i,
            });
        } else {
            i += sql[i..].chars().next().map_or(1, char::len_utf8);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn nested_comments_and_quoted_strings_hide_parameters_and_names() {
        let sql = "SELECT /* outer /* inner */ hidden $bad */ '$no' $$ $no $$ $tag$ $no $tag$, \"a\"\"b\", $yes -- $no\n";
        let found: Vec<_> = tokens(sql)
            .into_iter()
            .map(|t| (t.kind, &sql[t.range]))
            .collect();
        assert_eq!(
            found,
            vec![
                (Kind::Identifier, "SELECT"),
                (Kind::QuotedIdentifier, "\"a\"\"b\""),
                (Kind::Parameter, "$yes")
            ]
        );
    }
}
