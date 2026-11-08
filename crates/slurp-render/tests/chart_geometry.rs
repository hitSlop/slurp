use serde_json::json;
use slurp_render::{ChartRenderer, CompileOptions, Theme};

/// Exercise actual Vega marks, rather than only synthetic SVG rectangles. The
/// full-height bar must reach zero; the area must reach the plot's far edge.
#[test]
fn real_bars_and_areas_keep_their_baselines_and_endpoints() {
    let mut renderer = ChartRenderer::new();
    for width in [200, 100, 66] {
        for font in ["Geist", "Geist Mono"] {
            for theme in [Theme::light(), Theme::dark()] {
                let axes = json!({"axis":null,"type":"quantitative","scale":{"domain":[0,100],"nice":false}});
                for area in [false, true] {
                    let (spec, data) = if area {
                        (
                            json!({"mark":{"type":"area","color":"#0000ff","fillOpacity":1,"opacity":1},"padding":0,"autosize":"none","encoding":{"x":{"field":"x","axis":null,"type":"quantitative","scale":{"domain":[0,20],"nice":false}},"y":{"field":"y", "axis":axes["axis"],"type":axes["type"],"scale":axes["scale"]}}}),
                            json!({"columns":[{"name":"x","type":"INTEGER"},{"name":"y","type":"INTEGER"}],"rows":[[0,20],[10,80],[20,40]]}),
                        )
                    } else {
                        (
                            json!({"mark":{"type":"bar","color":"#00ff00"},"padding":0,"autosize":"none","encoding":{"x":{"field":"x","type":"nominal","axis":null,"scale":{"paddingInner":0,"paddingOuter":0}},"y":{"field":"y","axis":null,"type":"quantitative","scale":{"domain":[0,100],"nice":false}}}}),
                            json!({"columns":[{"name":"x","type":"VARCHAR"},{"name":"y","type":"INTEGER"}],"rows":[["A",25],["B",100]]}),
                        )
                    };
                    let chart = renderer
                        .compile(
                            &spec,
                            &data,
                            CompileOptions {
                                width,
                                height: 100,
                                font: font.into(),
                                theme: theme.clone(),
                            },
                        )
                        .unwrap();
                    assert!(chart.warnings.is_empty(), "{:?}", chart.warnings);
                    let page=renderer.render_page(&format!("<html><body style=\"margin:0;width:840px;background:white\">{}</body></html>",chart.svg),true,true).unwrap();
                    let image = tiny_skia::Pixmap::decode_png(&page.png.unwrap()).unwrap();
                    let expected = if area { (0, 0, 255) } else { (0, 255, 0) };
                    for (x, y) in [(width / 4, 95), (width - 3, 90)] {
                        let p = image.pixel(x * 2, y * 2).unwrap();
                        assert_eq!(
                            (p.red(), p.green(), p.blue()),
                            expected,
                            "width={width},font={font},theme={},area={area},point=({x},{y})",
                            theme.id()
                        );
                    }
                    let pdf = page.pdf.unwrap();
                    assert!(pdf.starts_with(b"%PDF-"));
                    // This simple chart uses vector paths/text, not an embedded chart bitmap.
                    assert!(!String::from_utf8_lossy(&pdf).contains("/Subtype /Image"));
                }
            }
        }
    }
}
