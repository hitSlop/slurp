use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use slurp_render::{ChartRenderer, CompileOptions};
use std::path::Path;

#[test]
fn fixture_charts_compile_with_correct_month_labels() {
    for slug in [
        "customer-growth",
        "enterprise-survey",
        "chart-cases",
        "utc-month",
    ] {
        let directory = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures")
            .join(slug);
        let def: Value =
            serde_json::from_slice(&std::fs::read(directory.join("definition.json")).unwrap())
                .unwrap();
        let run: Value =
            serde_json::from_slice(&std::fs::read(directory.join("run.json")).unwrap()).unwrap();
        let mut renderer = ChartRenderer::new();
        for (i, block) in def["blocks"].as_array().unwrap().iter().enumerate() {
            if block["kind"] != "chart" {
                continue;
            }
            let chart = renderer
                .compile(
                    &block["spec"],
                    &run["queries"][block["query"].as_str().unwrap()],
                    CompileOptions::default(),
                )
                .unwrap();
            assert!(chart.warnings.is_empty(), "{:?}", chart.warnings);
            if slug == "utc-month" {
                assert!(chart.svg.contains(">Nov 2025</text>"));
                assert!(!chart.svg.contains(">Oct 2025</text>"));
            }
            println!(
                "CHART {slug}-{i} {}",
                hex::encode(Sha256::digest(&chart.svg))
            );
        }
    }
}

#[test]
fn versions_and_hash_match_app() {
    let versions = slurp_render::versions();
    let app: Value =
        serde_json::from_str(include_str!("../../../report-assets/package.json")).unwrap();
    for name in ["vega", "vega-lite", "vega-interpreter"] {
        assert_eq!(
            versions[name.replace('-', "_")],
            app["dependencies"][name],
            "rebuild chart bundle after dependency changes"
        );
    }
    let bytes = zstd::decode_all(&include_bytes!("../assets/render.js.zst")[..]).unwrap();
    assert_eq!(
        versions["bundle_sha256"],
        hex::encode(Sha256::digest(bytes))
    );
}

#[test]
fn errors_warnings_and_sanitization() {
    let result = json!({"columns":[{"name":"x","type":"INTEGER"},{"name":"y","type":"DOUBLE"}],"rows":[["1","2.5"],["2",null]]});
    let mut renderer = ChartRenderer::new();
    for spec in [
        json!({"mark":"not_a_mark"}),
        json!({"mark":"bar","transform":[{"calculate":"unknownFunction(datum.x)","as":"z"}]}),
        json!({"mark":"bar","transform":[{"calculate":"datum.x +","as":"z"}]}),
    ] {
        assert!(
            renderer
                .compile(&spec, &result, CompileOptions::default())
                .is_err()
        );
    }
    let spec = json!({"data":{"url":"file:///must-not-open"},"mark":"bar","encoding":{"x":{"field":"x","type":"quantitative"},"y":{"field":"y","type":"quantitative"}}});
    let light = renderer
        .compile(&spec, &result, CompileOptions::default())
        .unwrap();
    assert!(!light.svg.contains("must-not-open"));
    let warning = renderer
        .compile(
            &json!({"mark":"bar","encoding":{"x":{"field":"x","type":"quantitative"},"shape":{"field":"x","type":"nominal"}}}),
            &result,
            CompileOptions::default(),
        )
        .unwrap();
    assert!(!warning.warnings.is_empty());
}

#[test]
fn empty_data_comes_from_transformed_datasets() {
    let mut renderer = ChartRenderer::new();
    let result = json!({"columns":[{"name":"x","type":"BIGINT"}],"rows":[["1"]]});
    let spec = json!({"encoding":{"x":{"field":"x","type":"quantitative"}},"layer":[
        {"mark":"bar"}, {"transform":[{"filter":"datum.x > 10"}],"mark":"text","encoding":{"text":{"field":"x"}}}
    ]});
    let chart = renderer
        .compile(&spec, &result, CompileOptions::default())
        .unwrap();
    assert_eq!(chart.empty_data, vec![".layer[1]"]);
    assert!(
        chart
            .warnings
            .iter()
            .all(|w| !w.contains("Infinite extent"))
    );
    let chart = renderer
        .compile(
            &json!({"mark":"bar","encoding":{"x":{"field":"x","type":"quantitative"}}}),
            &json!({"columns":result["columns"],"rows":[]}),
            CompileOptions::default(),
        )
        .unwrap();
    assert_eq!(chart.empty_data, vec![""]);
}

#[test]
fn numeric_categories_render_in_rank_order() {
    let directory = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/chart-cases");
    let read = |name| {
        serde_json::from_slice::<Value>(&std::fs::read(directory.join(name)).unwrap()).unwrap()
    };
    let definition = read("definition.json");
    let run = read("run.json");
    let mut renderer = ChartRenderer::new();
    for block in definition["blocks"].as_array().unwrap().iter().take(2) {
        let chart = renderer
            .compile(
                &block["spec"],
                &run["queries"]["q"],
                CompileOptions::default(),
            )
            .unwrap();
        // Numeric rank order rather than 1,10,11,...,2.
        let one = chart.svg.find(">Category 01</text>").unwrap();
        let two = chart.svg.find(">Category 02</text>").unwrap();
        let ten = chart.svg.find(">Category 10</text>").unwrap();
        assert!(one < two && two < ten);
    }
}

#[test]
fn rendering_is_byte_identical_in_utc_and_chicago() {
    // Spawn fresh processes: mutating TZ in a parallel test process is unsafe.
    let mut charts_by_zone = Vec::new();
    for zone in ["UTC", "America/Chicago"] {
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "fixture_charts_compile_with_correct_month_labels",
                "--nocapture",
            ])
            .env("TZ", zone)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{zone}: {} {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        let charts = String::from_utf8(output.stdout)
            .unwrap()
            .lines()
            .filter(|line| line.starts_with("CHART "))
            .map(str::to_owned)
            .collect::<Vec<_>>();
        assert!(!charts.is_empty(), "{zone}: no charts compiled");
        // customer-growth: 5, enterprise-survey: 4, chart-cases: 3, utc-month: 9.
        assert_eq!(charts.len(), 21, "{zone}: missing fixture charts");
        charts_by_zone.push(charts);
    }
    assert_eq!(
        charts_by_zone[0], charts_by_zone[1],
        "chart output changed with TZ"
    );
}

#[test]
fn chart_axis_layout_uses_actual_font_advances() {
    let mut renderer = ChartRenderer::new();
    let spec = json!({"mark":"bar","encoding":{"y":{"field":"label","type":"nominal","axis":{"title":null}},"x":{"field":"value","type":"quantitative","axis":{"title":null}}}});
    let mut width = |label: &str, font: &str| {
        let chart=renderer.compile(&spec,&json!({"columns":[{"name":"label","type":"VARCHAR"},{"name":"value","type":"DOUBLE"}],"rows":[[label,10]]}),CompileOptions{font:font.into(),width:200,height:100,..Default::default()}).unwrap();
        chart
            .svg
            .split(" width=\"")
            .nth(1)
            .unwrap()
            .split('"')
            .next()
            .unwrap()
            .parse::<u32>()
            .unwrap()
    };
    assert!(width("WWWWWWWWWW", "Geist") > width("iiiiiiiiii", "Geist") + 40);
    assert_eq!(
        width("WWWWWWWWWW", "Geist Mono"),
        width("iiiiiiiiii", "Geist Mono")
    );
}
