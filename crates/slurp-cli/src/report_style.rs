//! Page templates and themes for `slurp report build`.
//!
//! A *theme* is a set of colours (a built-in Perspective palette, or your own JSON file). A *template* is the page's CSS
//! with the theme's colours filled in. The same CSS drives the self-contained HTML (opened in a browser) and the PNG/PDF
//! (laid out by Takumi, a CSS-subset renderer), so only properties both understand are used: no `flex-wrap`, no
//! auto-placed `grid` spans, no `position`.
//!
//! `grid` is the only built-in template. Your own is a `.css` file (`--style my.css`, or `style: my.css` in a report's
//! front matter). Print the built-in one to start from with `slurp report show style grid`.
//!
//! The markup a template styles:
//!
//! ```text
//! <main>
//!   <div class="bar">
//!     <span class="brand"><b>slurp</b></span><span class="purpose">…</span><span class="date">…</span>
//!   </div>
//!   <div class="text"> …markdown… </div>
//!   <div class="row">                       (consecutive half or third width blocks)
//!     <section class="metric|chart|table [half|third]">
//!       <header><h2><span class="n">§1</span>Title</h2><span class="q">query_name</span></header>
//!       <div class="body"> …metric / table / svg chart… </div>
//!     </section>
//!   </div>
//! </main>
//! ```
//! A metric's body is `<p class="label">` and `<strong class="value">`. Numeric table cells carry `class="num"`.
//!
//! Placeholders filled from the theme: `%BG% %FG% %MUTED% %LINE% %ACCENT% %GRID% %AXIS% %NEG% %S1% %S2% %BRAND% %FONT%`.
//!
//! A template may start with a comment of directives, one per line:
//!
//! ```css
//! /* slurp-template
//!    font: mono                  mono (Geist Mono, the default) or sans (Geist)
//!    chart-widths: 782 382 250   pixels for a full, half and third width chart
//!    default-theme: pro-light
//! */
//! ```
use anyhow::{Context, Result, bail};
use slurp_render::{MONO, Palette, SANS, Theme};
use std::path::Path;

#[derive(Debug)]
pub struct Style {
    pub name: String,
    /// Palette used when neither the report nor the command line names a theme.
    pub default_theme: String,
    /// Font family for text and charts.
    pub font: &'static str,
    /// Usable chart width in pixels for a full, half and third width block.
    widths: (u32, u32, u32),
    template: String,
}

/// Slurp's brand red, for the top bar.
pub const BRAND: &str = "#e8002a";

/// The built-in template's name.
pub const BUILTIN: &str = "grid";

/// A name is a file when it names a `.css` / `.json` path; otherwise a built-in.
fn is_path(spec: &str, extension: &str) -> bool {
    spec.ends_with(extension) || spec.contains('/') || spec.contains('\\')
}

impl Style {
    /// The built-in `grid` template: a Perspective-style cell grid with a Slurp-red title bar.
    pub fn builtin() -> Self {
        Self::parse(BUILTIN, GRID).expect("the built-in template is valid")
    }

    /// Find a template: `grid`, or the path to a `.css` file (relative to `base`, the report's folder).
    ///
    /// # Errors
    /// Returns an error when the name is unknown or the file cannot be read or has a bad directive.
    pub fn resolve(spec: &str, base: &Path) -> Result<Self> {
        if spec == BUILTIN {
            return Ok(Self::builtin());
        }
        if !is_path(spec, ".css") {
            bail!(
                "unknown style {spec}; the built-in style is {BUILTIN}, or give the path to a .css template (see `slurp report show style {BUILTIN}`)"
            );
        }
        let path = base.join(spec);
        let css = std::fs::read_to_string(&path)
            .map_err(|e| anyhow::anyhow!("reading style {}: {e}", path.display()))?;
        Self::parse(spec, &css).map_err(|e| anyhow::anyhow!("style {}: {e:#}", path.display()))
    }

    /// The raw CSS of a template, before the colours are filled in.
    pub fn source(&self) -> &str {
        &self.template
    }

    fn parse(name: &str, css: &str) -> Result<Self> {
        let mut style = Self {
            name: name.to_owned(),
            default_theme: "pro-light".into(),
            font: MONO,
            widths: (782, 382, 250),
            template: css.to_owned(),
        };
        let trimmed = css.trim_start();
        if let Some(rest) = trimmed.strip_prefix("/* slurp-template") {
            let block = rest
                .split_once("*/")
                .map(|(b, _)| b)
                .context("the slurp-template comment is not closed")?;
            for line in block.lines().map(str::trim).filter(|l| !l.is_empty()) {
                let (key, value) = line
                    .split_once(':')
                    .with_context(|| format!("directive {line:?} needs a colon"))?;
                let value = value.trim();
                match key.trim() {
                    "font" => {
                        style.font = match value {
                            "mono" => MONO,
                            "sans" => SANS,
                            other => bail!("font must be mono or sans, not {other}"),
                        }
                    }
                    "chart-widths" => {
                        let w: Vec<u32> = value
                            .split_whitespace()
                            .map(str::parse)
                            .collect::<std::result::Result<_, _>>()
                            .context("chart-widths are three whole numbers")?;
                        let [full, half, third] = w[..] else {
                            bail!("chart-widths needs three numbers: full half third");
                        };
                        if !(100..=2000).contains(&third)
                            || third > half
                            || half > full
                            || full > 2000
                        {
                            bail!(
                                "chart-widths must be between 100 and 2000 and not grow: full >= half >= third"
                            );
                        }
                        style.widths = (full, half, third);
                    }
                    "default-theme" => style.default_theme = value.to_owned(),
                    other => {
                        bail!("unknown directive {other}; use font, chart-widths or default-theme")
                    }
                }
            }
        }
        Ok(style)
    }

    /// Chart width for a block width (`full`, `half`, `third`).
    pub fn chart_width(&self, width: &str) -> u32 {
        match width {
            "half" => self.widths.1,
            "third" => self.widths.2,
            _ => self.widths.0,
        }
    }

    /// The page CSS: font face, then the template with the theme's colours filled in.
    pub fn css(&self, palette: &Palette, font_data_base64: &str) -> String {
        let (family, fallback) = if self.font == MONO {
            ("Geist Mono", "monospace")
        } else {
            ("Geist", "sans-serif")
        };
        let series = |i: usize| palette.series.get(i).unwrap_or(&palette.accent).as_str();
        let mut css = format!(
            "@font-face{{font-family:'{family}';font-weight:100 900;src:url(data:font/ttf;base64,{font_data_base64})}}"
        );
        css.push_str(
            &self
                .template
                .replace("%FONT%", &format!("'{family}',{fallback}"))
                .replace("%BG%", &palette.bg)
                .replace("%FG%", &palette.fg)
                .replace("%MUTED%", &palette.inactive)
                .replace("%LINE%", &palette.border)
                .replace("%BRAND%", BRAND)
                .replace("%ACCENT%", &palette.accent)
                .replace("%GRID%", &palette.grid)
                .replace("%AXIS%", &palette.axis_lines)
                .replace("%NEG%", &palette.negative)
                .replace("%S1%", series(0))
                .replace("%S2%", series(1)),
        );
        css
    }
}

/// Find a theme: a built-in id (`pro-light`, `gruvbox-light`, ...), or the path to a theme `.json` file.
///
/// # Errors
/// Returns an error when the id is unknown or the file is unreadable or invalid.
pub fn resolve_theme(spec: &str, base: &Path) -> Result<Theme> {
    if !is_path(spec, ".json") {
        return Theme::named(spec).map_err(|e| anyhow::anyhow!(e.to_string()));
    }
    let path = base.join(spec);
    let text = std::fs::read_to_string(&path)
        .map_err(|e| anyhow::anyhow!("reading theme {}: {e}", path.display()))?;
    let value: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| anyhow::anyhow!("theme {} is not valid JSON: {e}", path.display()))?;
    Theme::custom(&value).map_err(|e| anyhow::anyhow!("theme {}: {e}", path.display()))
}

const GRID: &str = r#"/* slurp-template
   font: mono
   chart-widths: 782 382 250
   default-theme: pro-light
*/
*{box-sizing:border-box}
body{margin:0;background:%BG%;color:%FG%;font-family:%FONT%;font-size:12px}
main{width:840px;max-width:100%;display:flex;flex-direction:column;gap:1px;background:%LINE%;border:1px solid %LINE%}
.bar{width:100%;display:flex;flex-direction:row;align-items:center;gap:14px;padding:7px 14px;background:%BRAND%;color:#ffffff;font-size:10.5px}
.brand{display:flex;flex-direction:row;align-items:center;gap:8px}
.brand b{font-weight:700;letter-spacing:.16em;text-transform:uppercase}
.purpose{flex:1;color:#ffffffe6;font-size:11px}
.date{font-weight:600;letter-spacing:.04em}
.text{width:100%;padding:22px 24px 20px;background:%BG%}
.text h1{margin:0 0 10px;font-size:22px;line-height:1.2;letter-spacing:-.02em}
.text p{margin:0;line-height:1.75}
section{width:100%;display:flex;flex-direction:column;background:%BG%}
.row{width:100%;display:flex;flex-direction:row;gap:1px;background:%LINE%}.row section{flex:1;width:auto}
header{display:flex;flex-direction:row;justify-content:space-between;align-items:center;padding:8px 14px;border-bottom:1px solid %GRID%}
h2{margin:0;font-size:10.5px;font-weight:600;letter-spacing:.09em;text-transform:uppercase}
.n{display:none}.q{color:%MUTED%;font-size:10px}
.body{padding:12px 14px 14px}
.label{margin:0 0 6px;color:%MUTED%;font-size:10px;letter-spacing:.09em;text-transform:uppercase}
.value{display:block;font-size:34px;font-weight:700;line-height:1.05;letter-spacing:-.03em;color:%ACCENT%}
table{width:100%;border-collapse:collapse}
td,th{min-width:6ch;overflow-wrap:anywhere}
th{padding:5px 8px;text-align:left;font-size:10px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:%MUTED%;border-bottom:1px solid %AXIS%}
td{padding:5px 8px;border-bottom:1px solid %GRID%}
th.num,td.num{text-align:right;white-space:nowrap}
.more,.empty{margin:0;padding:8px 8px 0;color:%MUTED%;font-size:10px}
.empty{padding:18px 8px;font-size:11px}
.text p,.text li{overflow-wrap:anywhere}
.value{overflow-wrap:anywhere}
pre{margin:12px 0;padding:10px 12px;background:%GRID%;white-space:pre-wrap;overflow-wrap:anywhere;font-size:11px;line-height:1.55}
.text h2{margin:20px 0 8px;font-size:15px;font-weight:700;letter-spacing:-.01em;text-transform:none}
.text h3{margin:16px 0 6px;font-size:13px;font-weight:700}
.text h4{margin:12px 0 4px;font-size:12px;font-weight:700}
.text p+p{margin-top:8px}
.text ul,.text ol{margin:8px 0;padding-left:22px}
.text li{margin:3px 0;line-height:1.6}
.text blockquote{margin:12px 0;padding:6px 0 6px 14px;border-left:3px solid %ACCENT%}
.text blockquote p{margin:0}
.text hr{height:1px;border:0;background:%LINE%;margin:16px 0}
.text code{padding:1px 4px;background:%GRID%}
.text pre code{padding:0;background:transparent}
.text a{color:%ACCENT%;text-decoration:underline}
svg{max-width:100%;height:auto}
@media (max-width:700px){main{width:100%}.row{flex-direction:column}.row section{width:100%}.bar{gap:8px}.text{padding:16px 14px}}
@media print{body{background:#ffffff}main{width:100%}section,.row{break-inside:avoid}}"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_builtin_template_fills_every_placeholder_and_keeps_its_directives() {
        let style = Style::builtin();
        let palette = slurp_render::palette(&style.default_theme).expect("default theme exists");
        let css = style.css(palette, "AAAA");
        for token in [
            "%FONT%", "%BRAND%", "%BG%", "%FG%", "%MUTED%", "%LINE%", "%ACCENT%", "%GRID%",
            "%AXIS%", "%NEG%", "%S1%", "%S2%",
        ] {
            assert!(!css.contains(token), "unfilled {token}");
        }
        assert!(css.contains(&palette.bg) && css.contains("AAAA"));
        assert_eq!(style.chart_width("full"), 782);
        assert_eq!(style.chart_width("third"), 250);
    }

    #[test]
    fn a_css_file_is_a_template_and_its_directives_are_checked() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("mine.css"),
            "/* slurp-template\n font: sans\n chart-widths: 700 340 220\n*/body{background:%BG%}",
        )
        .unwrap();
        let style = Style::resolve("mine.css", dir.path()).unwrap();
        assert_eq!((style.font, style.chart_width("half")), (SANS, 340));
        assert!(
            style
                .css(slurp_render::palette("pro-light").unwrap(), "")
                .contains("font-family:'Geist'")
        );
        std::fs::write(
            dir.path().join("bad.css"),
            "/* slurp-template\n font: comic\n*/",
        )
        .unwrap();
        let err = Style::resolve("bad.css", dir.path()).unwrap_err();
        assert!(format!("{err:#}").contains("font must be mono or sans"));
        assert!(
            format!("{:#}", Style::resolve("nope", dir.path()).unwrap_err())
                .contains("unknown style nope")
        );
        assert!(Style::resolve("missing.css", dir.path()).is_err());
    }

    #[test]
    fn a_theme_file_can_be_tiny_extend_a_built_in_and_is_validated() {
        let dir = tempfile::tempdir().unwrap();
        let write = |name: &str, text: &str| std::fs::write(dir.path().join(name), text).unwrap();
        write(
            "tiny.json",
            r##"{"name":"Tiny Paper","bg":"#fffaf0","fg":"#222","accent":"#c2410c","series":["#c2410c","#0f766e","#7c3aed"]}"##,
        );
        let tiny = resolve_theme("tiny.json", dir.path()).unwrap();
        assert_eq!(tiny.palette().scheme, "light");
        assert_eq!(tiny.id(), "custom-tiny-paper");
        assert!(tiny.palette().border.starts_with('#') && tiny.palette().series.len() == 3);
        write(
            "dark.json",
            r##"{"extends":"pro-dark","accent":"#ff0066"}"##,
        );
        let dark = resolve_theme("dark.json", dir.path()).unwrap();
        assert_eq!(
            (
                dark.palette().scheme.as_str(),
                dark.palette().accent.as_str()
            ),
            ("dark", "#ff0066")
        );
        assert_eq!(
            dark.palette().bg,
            slurp_render::palette("pro-dark").unwrap().bg
        );
        write(
            "bad.json",
            r##"{"bg":"red","fg":"#000","accent":"#111","series":["#111"]}"##,
        );
        assert!(format!("{:#}", resolve_theme("bad.json", dir.path()).unwrap_err()).contains("bg"));
        write("short.json", r##"{"bg":"#fff","fg":"#000"}"##);
        assert!(
            format!("{:#}", resolve_theme("short.json", dir.path()).unwrap_err())
                .contains("accent")
        );
        assert!(
            format!("{:#}", resolve_theme("nope", dir.path()).unwrap_err())
                .contains("unknown theme nope")
        );
        assert_eq!(resolve_theme("dark", dir.path()).unwrap().id(), "pro-dark");
    }
}
