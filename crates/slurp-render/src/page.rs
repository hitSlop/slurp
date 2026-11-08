//! Browser-free whole-report layout. HTML is built by the shared app module.
use crate::{ChartError, MAX_INPUT, MAX_PIXELS, Result};
use std::sync::Arc;
use takumi::{prelude::*, unstable::base::html::parse_html};

pub const PAGE_WIDTH: u32 = 840;
/// The PNG is drawn at this many device pixels per layout pixel, so text and charts stay sharp on high-density screens and when
/// the image is shared in chat or email. The layout is still 840 px wide; the PNG is `PAGE_WIDTH * PNG_SCALE` pixels wide.
pub const PNG_SCALE: u32 = 2;

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
        let dense_parsed = parse_html(html, FromHtmlOptions::default()).map_err(ChartError::new)?;
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
                    // Match PNG fallback; the report builder already warns about uncovered glyphs.
                    .uncovered_text(takumi_pdf::UncoveredText::Placeholder)
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
