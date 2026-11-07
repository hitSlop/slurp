use serde_json::{Value, json};
use slurp_render::{ChartRenderer, CompileOptions, Theme};
use std::{path::Path, process::Command};

#[test]
fn report_pages_png_pdf_text_and_native_number_formatting() {
    let fixtures = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
    for slug in [
        "customer-growth",
        "enterprise-survey",
        "chart-cases",
        "page-formats",
    ] {
        let read = |name| {
            serde_json::from_slice::<Value>(&std::fs::read(fixtures.join(slug).join(name)).unwrap())
                .unwrap()
        };
        let definition = read("definition.json");
        let run = read("run.json");
        for theme in [Theme::light(), Theme::dark()] {
            let mut renderer = ChartRenderer::new();
            let mut charts = serde_json::Map::new();
            for (i, block) in definition["blocks"].as_array().unwrap().iter().enumerate() {
                if block["kind"] == "chart" {
                    let chart = renderer
                        .compile(
                            &block["spec"],
                            &run["queries"][block["query"].as_str().unwrap()],
                            CompileOptions {
                                theme: theme.clone(),
                                ..Default::default()
                            },
                        )
                        .unwrap();
                    charts.insert(i.to_string(), json!(chart.svg));
                }
            }
            let html = renderer
                .page_html(&definition, &run, &charts, theme)
                .unwrap();
            if slug == "page-formats" {
                for text in [
                    "10.4%",
                    "$1,234.50",
                    "12.3K",
                    "Margin 2026",
                    "Results for 2026",
                    "North",
                    "Markdown <strong>text</strong>",
                    "Filter: 2026.",
                    "<code>{year}</code>",
                    "<code>{x}</code>",
                    "&lt;script&gt;unsafe()&lt;/script&gt;",
                ] {
                    assert!(html.contains(text), "missing {text} in {html}");
                }
                assert!(!html.contains("<script>"));
            }
            let page = renderer.render_page(&html, true, true).unwrap();
            assert_eq!(page.width, 840);
            assert!(page.height > 200);
            let png = page.png.unwrap();
            assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
            assert_eq!(
                u32::from_be_bytes(png[20..24].try_into().unwrap()),
                page.height
            );
            let temp = tempfile::tempdir().unwrap();
            let path = temp.path().join("page.pdf");
            std::fs::write(&path, page.pdf.unwrap()).unwrap();
            let extracted = match Command::new("pdftotext")
                .args([path.to_str().unwrap(), "-"])
                .output()
            {
                Ok(output) => {
                    assert!(
                        output.status.success(),
                        "{}",
                        String::from_utf8_lossy(&output.stderr)
                    );
                    String::from_utf8(output.stdout).unwrap()
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    eprintln!("pdftotext unavailable; skipping PDF text extraction");
                    continue;
                }
                Err(error) => panic!("pdftotext: {error}"),
            };
            let text = extracted.split_whitespace().collect::<Vec<_>>().join(" ");
            let title = definition["title"]
                .as_str()
                .unwrap()
                .replace("{year}", "2026");
            assert!(text.contains(&title), "missing title {title} in {text}");
            if slug == "page-formats" {
                for required in [
                    "10.4%",
                    "$1,234.50",
                    "12.3K",
                    "Margin 2026",
                    "Results for 2026",
                    "North",
                    "rate",
                    "0.1037",
                    "Markdown text",
                    "Filter: 2026.",
                    "Syntax: {year} and {x}.",
                    "First finding",
                    "Second finding",
                ] {
                    assert!(text.contains(required), "missing {required} in PDF: {text}");
                }
            } else if slug == "customer-growth" {
                assert!(text.contains("Total customers"));
                assert!(text.contains("500,000"));
            }
        }
    }
}

#[test]
fn a_multi_row_metric_renders_an_error_not_its_first_row() {
    let result = |rows: Value| json!({"columns":[{"name":"n","type":"BIGINT"}],"rows":rows,"row_count":0,"truncated":false,"elapsed_ms":0});
    let definition = json!({
        "title":"Metrics",
        "queries":{"weekly":{"sql":"-"},"total":{"sql":"-"},"none":{"sql":"-"}},
        "blocks":[
            {"kind":"metric","query":"total","field":"n","label":"Total"},
            {"kind":"metric","query":"weekly","field":"n","label":"Weekly"},
            {"kind":"metric","query":"none","field":"n","label":"Nothing"}
        ]
    });
    let run = json!({
        "params":{},
        "queries":{"weekly":result(json!([[987654],[123]])),"total":result(json!([[42]])),"none":result(json!([]))},
        "errors":{},
        // The core resolves block errors; the export only displays them.
        "blocks": definition["blocks"].as_array().unwrap().iter().enumerate().map(|(i, block)| {
            let mut resolved = json!({"id":i.to_string(),"block":block});
            if i == 1 {
                resolved["error"] = json!({
                    "code":"metric_rows",
                    "message":"metric 'n' needs a one-row query, but query 'weekly' returns 2 rows (the viewer would otherwise show an arbitrary first row)"
                });
            }
            resolved
        }).collect::<Vec<_>>()
    });
    let html = ChartRenderer::new()
        .page_html(&definition, &run, &json!({}), Theme::light())
        .unwrap();
    assert!(html.contains("<strong>42</strong>"), "{html}");
    assert!(
        html.contains(
            "metric_rows: metric 'n' needs a one-row query, but query 'weekly' returns 2 rows"
        ),
        "{html}"
    );
    assert!(
        !html.contains("987,654") && !html.contains("987654"),
        "{html}"
    );
    assert!(
        html.contains("<span>Nothing</span><strong>—</strong>"),
        "{html}"
    );
}
