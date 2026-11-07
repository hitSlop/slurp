//! Browser-free whole-report layout. HTML is built by the shared app module.
use crate::{ChartError, MAX_INPUT, MAX_PIXELS, Result};
use std::sync::Arc;
use takumi::{prelude::*, unstable::base::html::parse_html};

pub const PAGE_WIDTH: u32 = 840;
/// The PNG is drawn at this many device pixels per layout pixel, so text and charts stay sharp on high-density screens and when
/// the image is shared in chat or email. The layout is still 840 px wide; the PNG is `PAGE_WIDTH * PNG_SCALE` pixels wide.
pub const PNG_SCALE: u32 = 2;

/// Takumi draws an inline `<svg>` at the page's device pixel ratio twice: its box is laid out at the right size, but the
/// drawing inside it is scaled by an extra PNG_SCALE, so a chart shows only its top-left corner. Widening each `viewBox` by
/// the same factor cancels that, and the chart fills its box exactly as it does at 1x. Verified by `svg_fills_its_box_at_png_scale`.
pub(crate) fn fit_svgs_to_density(html: &str, scale: u32) -> String {
    if scale <= 1 {
        return html.to_owned();
    }
    let mut out = String::with_capacity(html.len());
    let mut rest = html;
    while let Some(start) = rest.find("<svg") {
        let (before, tag_and_after) = rest.split_at(start);
        out.push_str(before);
        let Some(end) = tag_and_after.find('>') else {
            out.push_str(tag_and_after);
            return out;
        };
        let (tag, after) = tag_and_after.split_at(end + 1);
        out.push_str(&scale_view_box(tag, scale));
        rest = after;
    }
    out.push_str(rest);
    out
}

fn scale_view_box(tag: &str, scale: u32) -> String {
    const KEY: &str = "viewBox=\"";
    let Some(at) = tag.find(KEY) else {
        return tag.to_owned();
    };
    let value_start = at + KEY.len();
    let Some(len) = tag[value_start..].find('"') else {
        return tag.to_owned();
    };
    let numbers: Vec<f64> = tag[value_start..value_start + len]
        .split([' ', ','])
        .filter(|part| !part.is_empty())
        .filter_map(|part| part.parse().ok())
        .collect();
    if numbers.len() != 4 {
        return tag.to_owned();
    }
    let scaled: Vec<String> = numbers
        .iter()
        .map(|n| format!("{}", n * f64::from(scale)))
        .collect();
    format!(
        "{}{}{}",
        &tag[..value_start],
        scaled.join(" "),
        &tag[value_start + len..]
    )
}

pub struct RenderedPage {
    pub png: Option<Vec<u8>>,
    pub pdf: Option<Vec<u8>>,
    pub width: u32,
    pub height: u32,
}

pub(crate) fn fonts() -> Result<Fonts> {
    let mut fonts = Fonts::default();
    fonts
        .register(
            FontResource::new(include_bytes!("../assets/GeistVariable.ttf").to_vec())
                .override_info(FontOverride {
                    family_name: Some("Geist".into()),
                    ..Default::default()
                })
                .generic_family(GenericFamily::SANS_SERIF),
        )
        .map_err(ChartError::new)?;
    fonts
        .register(
            FontResource::new(include_bytes!("../assets/GeistMonoVariable.ttf").to_vec())
                .override_info(FontOverride {
                    family_name: Some("Geist Mono".into()),
                    ..Default::default()
                })
                .generic_family(GenericFamily::MONOSPACE),
        )
        .map_err(ChartError::new)?;
    Ok(fonts)
}

pub(crate) fn render(html: &str, fonts: &Fonts, png: bool, pdf: bool) -> Result<RenderedPage> {
    if html.len() > MAX_INPUT {
        return Err(ChartError::new("page HTML exceeds 32 MiB"));
    }
    let parsed = parse_html(html, FromHtmlOptions::default()).map_err(ChartError::new)?;
    let stylesheet = Arc::new(StyleSheet::parse_owned_list_loosy(parsed.css));
    let measured = takumi::measure(
        RenderOptions::builder()
            .viewport(Viewport::new((PAGE_WIDTH, 4000)))
            .node(parsed.node.clone())
            .fonts(fonts)
            .stylesheet(stylesheet.clone())
            .build(),
    )
    .map_err(ChartError::new)?;
    let height = measured.height.ceil();
    if !height.is_finite()
        || height <= 0.0
        || height > 65536.0
        || u64::from(PAGE_WIDTH) * height as u64 > MAX_PIXELS
    {
        return Err(ChartError::new(
            "page image exceeds 64 megapixels or 65536px height",
        ));
    }
    let height = height as u32;
    let viewport = Viewport::new((PAGE_WIDTH, height));
    let png = if png {
        // Measure again at the PNG's density: wrapping can differ by a pixel, and the image must fit its own layout exactly.
        let scale = PNG_SCALE as f32;
        let dense_html = fit_svgs_to_density(html, PNG_SCALE);
        let dense_parsed =
            parse_html(&dense_html, FromHtmlOptions::default()).map_err(ChartError::new)?;
        let dense_sheet = Arc::new(StyleSheet::parse_owned_list_loosy(dense_parsed.css));
        let dense = |height: u32| {
            Viewport::new((PAGE_WIDTH * PNG_SCALE, height)).with_device_pixel_ratio(scale)
        };
        let remeasured = takumi::measure(
            RenderOptions::builder()
                .viewport(dense(4000 * PNG_SCALE))
                .node(dense_parsed.node.clone())
                .fonts(fonts)
                .stylesheet(dense_sheet.clone())
                .build(),
        )
        .map_err(ChartError::new)?;
        let dense_height = remeasured.height.ceil();
        if !dense_height.is_finite()
            || dense_height <= 0.0
            || u64::from(PAGE_WIDTH * PNG_SCALE) * dense_height as u64 > MAX_PIXELS
        {
            return Err(ChartError::new("page image exceeds 64 megapixels"));
        }
        let image = takumi::render(
            RenderOptions::builder()
                .viewport(dense(dense_height as u32))
                .node(dense_parsed.node.clone())
                .fonts(fonts)
                .stylesheet(dense_sheet.clone())
                .build(),
        )
        .map_err(ChartError::new)?;
        let mut bytes = Vec::new();
        takumi::write_image(&image, &mut bytes, OutputFormat::Png).map_err(ChartError::new)?;
        Some(bytes)
    } else {
        None
    };
    let pdf = if pdf {
        Some(
            takumi_pdf::render(
                takumi_pdf::PdfOptions::builder()
                    .viewport(viewport)
                    .node(parsed.node)
                    .fonts(fonts)
                    .stylesheet(stylesheet)
                    .build(),
            )
            .map_err(ChartError::new)?,
        )
    } else {
        None
    };
    Ok(RenderedPage {
        png,
        pdf,
        width: PAGE_WIDTH,
        height,
    })
}
