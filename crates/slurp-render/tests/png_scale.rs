use slurp_render::ChartRenderer;

/// Inline SVG retains its CSS-pixel geometry in the 2x output.
#[test]
fn svg_fills_its_box_at_png_scale() {
    let svg = r##"<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100"><rect width="200" height="100" fill="#ffffff"/><rect x="0" y="0" width="20" height="100" fill="#ff0000"/><rect x="180" y="0" width="20" height="100" fill="#0000ff"/></svg>"##;
    let html = format!(
        "<!doctype html><html><body style=\"margin:0;width:840px;background:#ffffff\">{svg}</body></html>"
    );
    let mut renderer = ChartRenderer::new();
    let page = renderer.render_page(&html, true, false).unwrap();
    let scale = slurp_render::PNG_SCALE;
    let image = tiny_skia::Pixmap::decode_png(&page.png.unwrap()).unwrap();
    let pixel = |x: u32, y: u32| {
        let p = image.pixel(x, y).unwrap();
        (p.red(), p.green(), p.blue())
    };
    // The 200x100 box is 400x200 device pixels; the red stripe is its left 10%, the blue its right 10%.
    assert_eq!(
        pixel(2 * scale, 20 * scale),
        (255, 0, 0),
        "left edge of the drawing"
    );
    assert_eq!(
        pixel(199 * scale - 2, 20 * scale),
        (0, 0, 255),
        "right edge of the drawing"
    );
    assert_eq!(
        pixel(100 * scale, 50 * scale),
        (255, 255, 255),
        "the middle between the stripes"
    );
}

fn png_pixel(html: &str) -> impl Fn(u32, u32) -> (u8, u8, u8) + use<> {
    let mut renderer = ChartRenderer::new();
    let page = renderer.render_page(html, true, false).unwrap();
    let image = tiny_skia::Pixmap::decode_png(&page.png.unwrap()).unwrap();
    move |x, y| {
        let p = image.pixel(x, y).unwrap();
        (p.red(), p.green(), p.blue())
    }
}

/// A chart is a plot group, moved into place, whose marks fill it. Marks must not be clipped to the plot's top-left quarter: a bar
/// that reaches the baseline and a line that reaches the right edge are drawn to their ends.
#[test]
fn chart_marks_are_not_clipped_at_png_scale() {
    let svg = r##"<svg xmlns="http://www.w3.org/2000/svg" class="marks" width="200" height="100" viewBox="0 0 200 100"><g transform="translate(20,10)"><path d="M0,0h160v80h-160Z" fill="#00ff00"/></g></svg>"##;
    let pixel = png_pixel(&format!(
        "<!doctype html><html><body style=\"margin:0;width:840px;background:#ffffff\">{svg}</body></html>"
    ));
    let scale = slurp_render::PNG_SCALE;
    assert_eq!(
        pixel(21 * scale, 11 * scale),
        (0, 255, 0),
        "top-left of the plot"
    );
    assert_eq!(
        pixel(179 * scale, 89 * scale),
        (0, 255, 0),
        "bottom-right of the plot, which a clipped chart loses"
    );
    assert_eq!(
        pixel(10 * scale, 50 * scale),
        (255, 255, 255),
        "outside the plot"
    );
}

/// A drawing with no pixel size (an icon sized by CSS) still fills its box.
#[test]
fn an_svg_without_a_pixel_size_still_fills_its_box() {
    let svg = r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" style="width:100px;height:100px"><rect width="100" height="100" fill="#ff0000"/></svg>"##;
    let pixel = png_pixel(&format!(
        "<!doctype html><html><body style=\"margin:0;width:840px;background:#ffffff\">{svg}</body></html>"
    ));
    let scale = slurp_render::PNG_SCALE;
    assert_eq!(pixel(98 * scale, 98 * scale), (255, 0, 0));
}

#[test]
fn css_sized_paths_and_single_quoted_attributes_keep_their_geometry() {
    for svg in [
        r##"<svg xmlns="http://www.w3.org/2000/svg" style="width:200px;height:100px" viewBox="0 0 200 100"><g transform="translate(20,10)"><path d="M0,0h160v80h-160Z" fill="#00ff00"/></g></svg>"##,
        r##"<svg xmlns='http://www.w3.org/2000/svg' width='200' height='100' viewBox='0 0 200 100'><g transform='translate(20,10)'><path d='M0,0h160v80h-160Z' fill='#00ff00'/></g></svg>"##,
    ] {
        let pixel = png_pixel(&format!(
            "<html><body style=\"margin:0;width:840px;background:white\">{svg}</body></html>"
        ));
        assert_eq!(pixel(42, 22), (0, 255, 0), "plot origin: {svg}");
        assert_eq!(pixel(358, 178), (0, 255, 0), "plot endpoint: {svg}");
        assert_eq!(pixel(20, 100), (255, 255, 255), "outside plot: {svg}");
    }
}

#[test]
fn inline_svg_preserves_page_css_and_author_sizing() {
    let html = r##"<html><head><style>.marks rect{fill:#00ff00}</style></head><body style="margin:0;width:840px;background:white"><svg xmlns="http://www.w3.org/2000/svg" class="marks" width="200" height="100" style="width:100px;height:50px" viewBox="0 0 200 100"><rect width="200" height="100"/></svg></body></html>"##;
    let pixel = png_pixel(html);
    assert_eq!(
        pixel(190, 90),
        (0, 255, 0),
        "page styling reaches SVG descendants"
    );
    assert_eq!(
        pixel(220, 90),
        (255, 255, 255),
        "CSS width overrides the SVG attribute"
    );
}
