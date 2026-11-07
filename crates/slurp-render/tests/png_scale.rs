use slurp_render::ChartRenderer;

/// Inline SVG charts must fill their box in the 2x PNG. Takumi scales the drawing inside an `<svg>` by the pixel ratio a second
/// time, which the renderer cancels by widening each viewBox; without that only the top-left corner of a chart is visible.
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
