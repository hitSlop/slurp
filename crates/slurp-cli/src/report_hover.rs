//! Hover details for the HTML report.
//!
//! Every Vega-Lite mark already carries a description of its data in `aria-label` ("week: 3; % active: 41"). Two layers
//! make that visible, for the HTML file only (the PNG and PDF never see it):
//!
//! 1. every data mark gets a `<title>` child, so any browser shows a native tooltip, with no script at all;
//! 2. one small inline script shows a styled tooltip instead, highlights the mark under the pointer, works on tap and
//!    removes the native titles. The report's Content-Security-Policy allows exactly that script by its SHA-256 hash.
use base64::Engine;
use sha2::{Digest, Sha256};

/// The tooltip script, written once in `assets/hover.js`.
pub const SCRIPT: &str = include_str!("../assets/hover.js");

/// Marks whose label describes only part of what is under the pointer (one label for a whole line) or is not data.
const SKIPPED: [&str; 6] = [
    "axis",
    "legend",
    "title",
    "line mark",
    "area mark",
    "trail mark",
];

/// The CSP source for [`SCRIPT`]: it may run, and nothing else may.
pub fn script_source() -> String {
    format!(
        "'sha256-{}'",
        base64::engine::general_purpose::STANDARD.encode(Sha256::digest(SCRIPT.as_bytes()))
    )
}

fn attribute<'a>(tag: &'a str, name: &str) -> Option<&'a str> {
    let needle = format!(" {name}=\"");
    let from = tag.find(&needle)? + needle.len();
    Some(&tag[from..from + tag[from..].find('"')?])
}

/// Give every data mark that has an `aria-label` a `<title>` with the same text.
pub fn titles(body: &str) -> String {
    let mut out = String::with_capacity(body.len() + body.len() / 8);
    let mut rest = body;
    while let Some(at) = rest.find('<') {
        out.push_str(&rest[..at]);
        rest = &rest[at..];
        let Some(end) = rest.find('>') else { break };
        let tag = &rest[..=end];
        let name = tag[1..].split([' ', '>', '/']).next().unwrap_or_default();
        let described = matches!(name, "path" | "text" | "rect" | "circle")
            && attribute(tag, "role") == Some("graphics-symbol")
            && !attribute(tag, "aria-roledescription").is_some_and(|d| SKIPPED.contains(&d));
        match attribute(tag, "aria-label").filter(|_| described) {
            Some(label) if tag.ends_with("/>") => {
                out.push_str(&tag[..tag.len() - 2]);
                out.push_str(&format!("><title>{label}</title></{name}>"));
            }
            Some(label) => {
                out.push_str(tag);
                out.push_str(&format!("<title>{label}</title>"));
            }
            None => out.push_str(tag),
        }
        rest = &rest[end + 1..];
    }
    out.push_str(rest);
    out
}

/// Tooltip styling in the report's own theme colors.
pub fn css(palette: &slurp_render::Palette) -> String {
    format!(
        ".slurp-tip{{position:fixed;z-index:10;max-width:280px;padding:8px 10px;border-radius:6px;background:{bg};color:{fg};font-size:11px;line-height:1.5;box-shadow:0 6px 20px #0003;pointer-events:none}}\
         .slurp-tip[hidden]{{display:none}}.slurp-tip span{{opacity:.7}}\
         .slurp-hover{{stroke:{ring};stroke-width:1.5px}}",
        bg = palette.tooltip_bg,
        fg = palette.tooltip_fg,
        ring = palette.fg
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn data_marks_get_titles_and_everything_else_is_left_alone() {
        let svg = concat!(
            "<g role=\"graphics-symbol\" aria-roledescription=\"axis\" aria-label=\"X-axis titled w\"><path d=\"M0\"/></g>",
            "<path aria-label=\"week: 1; % active: 51\" role=\"graphics-symbol\" aria-roledescription=\"rect mark\" d=\"M0,0\" fill=\"red\"/>",
            "<path aria-label=\"week: 1\" role=\"graphics-symbol\" aria-roledescription=\"line mark\" d=\"M0,0L1,1\"/>",
            "<text aria-label=\"cell: 7\" role=\"graphics-symbol\" aria-roledescription=\"text mark\" x=\"1\">7</text>",
            "<path d=\"M1,1\" aria-label=\"decorative\"/>"
        );
        let out = titles(svg);
        assert!(
            out.contains("fill=\"red\"><title>week: 1; % active: 51</title></path>"),
            "{out}"
        );
        assert!(
            out.contains("x=\"1\"><title>cell: 7</title>7</text>"),
            "{out}"
        );
        assert_eq!(out.matches("<title>").count(), 2, "{out}");
        assert!(
            out.contains("aria-roledescription=\"line mark\" d=\"M0,0L1,1\"/>"),
            "a whole line has no single label"
        );
        assert!(out.contains("aria-label=\"X-axis titled w\"><path d=\"M0\"/></g>"));
    }

    #[test]
    fn the_script_is_allowed_by_its_hash_and_only_sets_text_safely() {
        assert!(script_source().starts_with("'sha256-") && script_source().ends_with("='"));
        assert!(
            !SCRIPT.contains("innerHTML")
                && !SCRIPT.contains("eval(")
                && !SCRIPT.contains("</script")
        );
    }
}
