use anyhow::Result;
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use slurp_render::{ChartRenderer, CompileOptions, Theme};
use std::{fs, path::Path, sync::Arc, time::Instant};
use takumi::{prelude::*, unstable::base::html::parse_html};
fn native(html: &str, fonts: &Fonts, scale: u32) -> Result<(Vec<u8>, Vec<u8>)> {
    let parsed = parse_html(html, FromHtmlOptions::default())?;
    let sheet = Arc::new(StyleSheet::parse_owned_list_loosy(parsed.css));
    let viewport = |h| Viewport::new((840 * scale, h)).with_device_pixel_ratio(scale as f32);
    let measured = takumi::measure(
        RenderOptions::builder()
            .viewport(viewport(8000))
            .node(parsed.node.clone())
            .fonts(fonts)
            .stylesheet(sheet.clone())
            .build(),
    )?;
    anyhow::ensure!(
        measured.height.is_finite()
            && measured.height > 0.0
            && measured.height * (840 * scale) as f32 <= 67108864.0,
        "pixel budget"
    );
    let img = takumi::render(
        RenderOptions::builder()
            .viewport(viewport(measured.height.ceil() as u32))
            .node(parsed.node.clone())
            .fonts(fonts)
            .stylesheet(sheet.clone())
            .build(),
    )?;
    let mut png = Vec::new();
    takumi::write_image(&img, &mut png, OutputFormat::Png)?;
    let pdf = takumi_pdf::render(
        takumi_pdf::PdfOptions::builder()
            .viewport(Viewport::new((
                840,
                (measured.height / scale as f32).ceil() as u32,
            )))
            .node(parsed.node)
            .fonts(fonts)
            .stylesheet(sheet)
            .build(),
    )?;
    Ok((png, pdf))
}
fn main() -> Result<()> {
    let args: Vec<_> = std::env::args().collect();
    let mode = args.get(1).map(String::as_str).unwrap_or("baseline");
    let out = Path::new(args.get(2).expect("output directory"));
    fs::create_dir_all(out)?;
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let mut fonts = Fonts::default();
    let mut db = resvg::usvg::fontdb::Database::new();
    for file in ["GeistVariable.ttf", "GeistMonoVariable.ttf"] {
        let bytes = fs::read(root.join("crates/slurp-render/assets").join(file))?;
        fonts.register(FontResource::new(bytes.clone()))?;
        db.load_font_data(bytes);
    }
    db.set_sans_serif_family("Geist");
    db.set_monospace_family("Geist Mono");
    let options = resvg::usvg::Options {
        fontdb: Arc::new(db),
        ..Default::default()
    };
    let mut font_css = String::new();
    for (file, family) in [
        ("GeistVariable.ttf", "Geist"),
        ("GeistMonoVariable.ttf", "Geist Mono"),
    ] {
        font_css.push_str(&format!("@font-face{{font-family:'{family}';src:url(data:font/ttf;base64,{});font-weight:100 900}}", STANDARD.encode(fs::read(root.join("crates/slurp-render/assets").join(file))?)));
    }
    let mut renderer = ChartRenderer::new();
    let mut records = Vec::new();
    let mut cases = Vec::new();
    for slug in [
        "customer-growth",
        "enterprise-survey",
        "chart-cases",
        "utc-month",
    ] {
        let dir = root.join("crates/slurp-render/tests/fixtures").join(slug);
        let def: Value = serde_json::from_slice(&fs::read(dir.join("definition.json"))?)?;
        let run: Value = serde_json::from_slice(&fs::read(dir.join("run.json"))?)?;
        for (i, block) in def["blocks"].as_array().unwrap().iter().enumerate() {
            if block["kind"] == "chart" {
                cases.push((
                    format!("{slug}-{i}"),
                    block["spec"].clone(),
                    run["queries"][block["query"].as_str().unwrap()].clone(),
                ));
            }
        }
    }
    let variations: Vec<_> = cases
        .iter()
        .take(3)
        .flat_map(|(name, spec, data)| {
            [
                (format!("{name}--dark-mono-250"), spec.clone(), data.clone()),
                (
                    format!("{name}--light-sans-382"),
                    spec.clone(),
                    data.clone(),
                ),
            ]
        })
        .collect();
    cases.extend(variations);
    let mut gallery = String::new();
    for (name, spec, data) in cases {
        let start = Instant::now();
        let opts = CompileOptions {
            width: if name.ends_with("250") {
                250
            } else if name.ends_with("382") {
                382
            } else {
                640
            },
            font: if name.contains("mono") {
                "Geist Mono".into()
            } else {
                "Geist".into()
            },
            theme: if name.contains("dark") {
                Theme::dark()
            } else {
                Theme::light()
            },
            ..Default::default()
        };
        let mut chart = renderer.compile(&spec, &data, opts)?;
        if let Ok(dir) = std::env::var("SPIKE_SVG_DIR") {
            chart.svg = fs::read_to_string(Path::new(&dir).join(format!("{name}.svg")))?;
        }
        let compile_ms = start.elapsed().as_secs_f64() * 1000.;
        fs::write(out.join(format!("{name}.svg")), &chart.svg)?;
        let raster_start = Instant::now();
        let content = if mode.starts_with("resvg") {
            let tree = resvg::usvg::Tree::from_str(&chart.svg, &options)?;
            let scale = if mode == "resvg4" { 4. } else { 2. };
            let size = tree.size().to_int_size();
            let mut pix = resvg::tiny_skia::Pixmap::new(
                (size.width() as f32 * scale) as u32,
                (size.height() as f32 * scale) as u32,
            )
            .unwrap();
            resvg::render(
                &tree,
                resvg::tiny_skia::Transform::from_scale(scale, scale),
                &mut pix.as_mut(),
            );
            format!(
                "<img width=\"{}\" height=\"{}\" style=\"max-width:100%;height:auto\" src=\"data:image/png;base64,{}\">",
                size.width(),
                size.height(),
                STANDARD.encode(pix.encode_png()?)
            )
        } else {
            chart.svg.clone()
        };
        let raster_ms = raster_start.elapsed().as_secs_f64() * 1000.;
        let html = format!(
            "<html><head><style>{font_css}svg{{max-width:100%;height:auto}}</style></head><body style=\"margin:0;width:840px;background:white;font-family:Geist\"><div style=\"padding:14px\">{content}</div></body></html>"
        );
        fs::write(out.join(format!("{name}.html")), &html)?;
        gallery.push_str(&format!("<section><h2>{name}</h2>{content}</section>"));
        let mut times = Vec::new();
        let mut first_png: Option<Vec<u8>> = None;
        for iteration in 0..3 {
            let t = Instant::now();
            let (png, pdf) = if mode == "baseline" || mode.starts_with("resvg") {
                let p = renderer.render_page(&html, true, true)?;
                (p.png.unwrap(), p.pdf.unwrap())
            } else {
                native(&html, &fonts, 2)?
            };
            if let Some(first) = &first_png {
                anyhow::ensure!(*first == png, "non-deterministic PNG: {name}");
            } else {
                first_png = Some(png.clone());
            }
            times.push(t.elapsed().as_secs_f64() * 1000.);
            if iteration == 0 {
                fs::write(out.join(format!("{name}.png")), png)?;
                fs::write(out.join(format!("{name}.pdf")), pdf)?;
            }
        }
        records.push(json!({"case":name,"compile_ms":compile_ms,"chart_prepare_ms":raster_ms,"render_ms":times,"warnings":chart.warnings,"empty_data":chart.empty_data}));
    }
    fs::write(
        out.join("measurements.json"),
        serde_json::to_vec_pretty(&json!({"mode":mode,"cases":records}))?,
    )?;
    let full = format!(
        "<html><head><style>{font_css}body{{margin:0;width:840px;font-family:Geist}}section{{padding:14px}}h2{{font-size:14px}}svg,img{{max-width:100%;height:auto}}</style></head><body>{gallery}<p>END OF REPORT</p></body></html>"
    );
    fs::write(out.join("gallery.html"), &full)?;
    let (png, pdf) = if mode == "patched" {
        native(&full, &fonts, 2)?
    } else {
        let p = renderer.render_page(&full, true, true)?;
        (p.png.unwrap(), p.pdf.unwrap())
    };
    fs::write(out.join("gallery.png"), png)?;
    fs::write(out.join("gallery.pdf"), pdf)?;
    let probes = [
        (
            "sized-path",
            r##"<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100"><g transform="translate(20,10)"><path d="M0,0h160v80h-160Z" fill="#00ff00"/></g></svg>"##,
        ),
        (
            "css-sized-path",
            r##"<svg xmlns="http://www.w3.org/2000/svg" style="width:200px;height:100px" viewBox="0 0 200 100"><g transform="translate(20,10)"><path d="M0,0h160v80h-160Z" fill="#00ff00"/></g></svg>"##,
        ),
        (
            "single-quotes",
            r##"<svg xmlns='http://www.w3.org/2000/svg' width='200' height='100' viewBox='0 0 200 100'><g transform='translate(20,10)'><path d='M0,0h160v80h-160Z' fill='#00ff00'/></g></svg>"##,
        ),
    ];
    let mut checks = Vec::new();
    for (name, svg) in probes {
        let content = if mode.starts_with("resvg") {
            let tree = resvg::usvg::Tree::from_str(svg, &options)?;
            let mut pix = resvg::tiny_skia::Pixmap::new(400, 200).unwrap();
            resvg::render(
                &tree,
                resvg::tiny_skia::Transform::from_scale(2., 2.),
                &mut pix.as_mut(),
            );
            format!(
                "<img width=\"200\" height=\"100\" src=\"data:image/png;base64,{}\">",
                STANDARD.encode(pix.encode_png()?)
            )
        } else {
            svg.to_owned()
        };
        let html = format!(
            "<html><body style=\"margin:0;width:840px;background:white\">{content}</body></html>"
        );
        let png = if mode == "patched" {
            native(&html, &fonts, 2)?.0
        } else {
            renderer.render_page(&html, true, false)?.png.unwrap()
        };
        let image = resvg::tiny_skia::Pixmap::decode_png(&png)?;
        let green = |x, y| {
            let p = image.pixel(x, y).unwrap();
            p.green() > 240 && p.red() < 10 && p.blue() < 10
        };
        let passed = green(42, 22) && green(358, 178) && !green(20, 100);
        checks.push(json!({"case":name,"passed":passed}));
        fs::write(out.join(format!("probe-{name}.png")), png)?;
    }
    fs::write(out.join("checks.json"), serde_json::to_vec_pretty(&checks)?)?;
    let _ = Theme::light();
    Ok(())
}
