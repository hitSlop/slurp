//! Chart labels use the same bundled fonts and shaping engine as the report page.
use crate::{ChartError, MONO, Result, SANS, page};
use takumi::{prelude::*, unstable::base::html::parse_html};

pub(crate) struct TextMeasurer {
    fonts: Fonts,
}
impl TextMeasurer {
    pub(crate) fn new() -> Result<Self> {
        Ok(Self {
            fonts: page::fonts()?,
        })
    }

    pub(crate) fn width(
        &self,
        text: &str,
        family: &str,
        size: f64,
        weight: &str,
        style: &str,
        variant: &str,
    ) -> Result<f64> {
        if text.len() > 32768 || !size.is_finite() || !(0.0..=4096.0).contains(&size) {
            return Err(ChartError::new(
                "chart text exceeds 32 KiB or its font size is outside 0..4096",
            ));
        }
        if text.is_empty() || size == 0.0 {
            return Ok(0.0);
        }
        let family = family
            .split(',')
            .find_map(|name| {
                let name = name.trim().trim_matches(['\'', '"']).to_ascii_lowercase();
                match name.as_str() {
                    "geist mono" | "monospace" => Some(MONO),
                    "geist" | "sans-serif" => Some(SANS),
                    _ => None,
                }
            })
            .unwrap_or(SANS);
        let weight = match weight {
            "bold" | "bolder" => 700.0,
            "lighter" => 100.0,
            other => other
                .parse::<f64>()
                .ok()
                .filter(|w| w.is_finite() && (1.0..=1000.0).contains(w))
                .unwrap_or(400.0),
        };
        let style = match style {
            "italic" => "italic",
            "oblique" => "oblique",
            _ => "normal",
        };
        let variant = if variant == "small-caps" {
            "small-caps"
        } else {
            "normal"
        };
        let text = text
            .replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;");
        // Unconstrained, preformatted inline content measures advance width without wrapping or HTML interpretation.
        let html = format!(
            "<span style=\"display:inline-block;white-space:pre;font-family:'{family}';font-size:{size}px;font-weight:{weight};font-style:{style};font-variant:{variant}\">{text}</span>"
        );
        let parsed = parse_html(&html, FromHtmlOptions::default()).map_err(ChartError::new)?;
        let measured = takumi::measure(
            RenderOptions::builder()
                .viewport(Viewport::new((None, None)))
                .node(parsed.node)
                .fonts(&self.fonts)
                .build(),
        )
        .map_err(ChartError::new)?;
        if !measured.width.is_finite() {
            return Err(ChartError::new("chart text measurement is not finite"));
        }
        Ok(f64::from(measured.width))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn glyphs_family_weight_and_size_affect_advance_width() {
        let m = TextMeasurer::new().unwrap();
        let width = |t, f, s, w| m.width(t, f, s, w, "normal", "normal").unwrap();
        assert!(
            width("WWWWWWWWWW", SANS, 12.0, "400") > width("iiiiiiiiii", SANS, 12.0, "400") * 2.0
        );
        assert!((width("WWWW", MONO, 12.0, "400") - width("iiii", MONO, 12.0, "400")).abs() < 0.1);
        assert!(
            (width("Hello", SANS, 24.0, "400") - 2.0 * width("Hello", SANS, 12.0, "400")).abs()
                < 0.2
        );
        assert!(width("Hello", SANS, 12.0, "700") > width("Hello", SANS, 12.0, "400"));
        assert!(width("<b>&", SANS, 12.0, "400") > 0.0);
        assert_eq!(
            width("WWWW", "Geist, Geist Mono", 12.0, "400"),
            width("WWWW", SANS, 12.0, "400")
        );
        assert_eq!(
            width("WWWW", "\"GEIST MONO\", monospace", 12.0, "400"),
            width("WWWW", MONO, 12.0, "400")
        );
        assert_eq!(width("", SANS, 12.0, "400"), 0.0);
        assert!(
            m.width("x", SANS, f64::INFINITY, "400", "normal", "normal")
                .is_err()
        );
    }
}
