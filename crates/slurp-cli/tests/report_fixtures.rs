//! Report layout and authoring-error regression tests. The fixtures are deliberately hostile: long unbroken text, wide tables,
//! non-Latin text, empty results, 1,000-point charts, and every kind of mistake an author can make.
mod common;
use slurp_app::{Workspace, report, report_check};
use std::path::{Path, PathBuf};

fn workspace() -> Option<(tempfile::TempDir, Workspace)> {
    let exe = common::duckdb()?;
    let temp = tempfile::tempdir().expect("test directory");
    let w = Workspace::init(
        &(temp.path()).join("private-home"),
        temp.path(),
        "http://localhost:8080".into(),
        "prj_fixture".into(),
        None,
        exe.into(),
    )
    .expect("initialize workspace");
    Some((temp, w))
}
fn fixture(dir: &str, name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(dir)
        .join(name)
}
/// Width and height from the PNG header.
/// Device pixels per layout pixel in report PNGs (slurp_render::page::PNG_SCALE).
const SCALE: u32 = slurp_render::PNG_SCALE;
fn png_size(path: &Path) -> (u32, u32) {
    let bytes = std::fs::read(path).expect("png");
    assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n");
    let number = |at: usize| u32::from_be_bytes(bytes[at..at + 4].try_into().unwrap());
    (number(16), number(20))
}
fn build(w: &Workspace, name: &str, out: &Path) -> serde_json::Value {
    report::build(w, &fixture("reports", name), out, false, true, false)
        .unwrap_or_else(|e| panic!("{name} should build: {e:#}"))
}
fn within(actual: u32, expected: u32, what: &str) {
    let slack = expected / 8;
    assert!(
        actual.abs_diff(expected) <= slack,
        "{what}: the page is {actual}px tall, expected about {expected}px. A change this large means the layout moved \
         (wrapping, clipping or spacing); if it is intended, update the expected height"
    );
}

#[test]
fn hostile_layouts_do_not_clip_overflow_or_lose_their_notices() {
    let Some((temp, w)) = workspace() else { return };
    let out = temp.path().join("layout");
    let manifest = build(&w, "layout.md", &out);
    let html = std::fs::read_to_string(out.join("report.html")).unwrap();
    // Numbers read naturally and follow the block's options.
    for text in [
        "1,234,567.89",
        "-$42.00",
        "0.000123",
        "12,345,678,901,234,567,890",
        "—",
    ] {
        assert!(html.contains(text), "missing {text}");
    }
    // A table says it is showing part of its rows.
    assert!(html.contains("Showing the first 5 of 250 rows"));
    // Long text wraps instead of clipping, in the template the PNG is rendered from.
    assert!(html.contains("overflow-wrap:anywhere"));
    // Thirds and halves are laid out in rows, and a lone half fills its row.
    assert!(html.matches("class=\"row\"").count() >= 3);
    let (width, height) = png_size(&out.join("report.png"));
    let height = height / SCALE; // the PNG is drawn at 2x; layout heights are in layout pixels
    assert_eq!(width, 840 * SCALE);
    within(height, 1240, "layout fixture");
    assert!(manifest.get("warnings").is_none(), "{manifest}");
}

#[test]
fn text_charts_and_empty_results_render_safely() {
    let Some((temp, w)) = workspace() else { return };
    let out = temp.path().join("text");
    let manifest = build(&w, "text-and-charts.md", &out);
    let html = std::fs::read_to_string(out.join("report.html")).unwrap();
    assert!(
        !html.contains("<script>alert"),
        "cell and label text must be escaped"
    );
    assert!(html.contains("&lt;script&gt;"));
    assert!(
        html.contains("class=\"empty\""),
        "an empty chart says so instead of drawing an axis"
    );
    assert!(html.contains("No rows match this query."));
    // Characters the PNG font cannot draw are reported once, not silently shown as boxes.
    let warnings = manifest["warnings"].to_string();
    assert!(warnings.contains("cannot be drawn"), "{warnings}");
    let (width, height) = png_size(&out.join("report.png"));
    let height = height / SCALE; // the PNG is drawn at 2x; layout heights are in layout pixels
    assert_eq!(width, 840 * SCALE);
    within(height, 2170, "text and charts fixture");
    // Hover details: a native tooltip on every data mark, and one script that the policy allows by hash and nothing else.
    assert!(
        html.matches("<title>").count() > 20,
        "data marks carry titles"
    );
    assert!(html.contains(&format!(
        "script-src {}",
        slurp_app::report_hover::script_source()
    )));
    assert_eq!(html.matches("<script").count(), 1);
    assert!(html.contains(&format!(
        "<script>{}</script>",
        slurp_app::report_hover::SCRIPT
    )));
    assert!(
        !html.contains("slurp-hover") || html.contains(".slurp-hover{"),
        "highlight style ships with the script"
    );
    // The top bar is just the word and the report's purpose and date: no image.
    assert!(html.contains("<span class=\"brand\"><b>slurp</b></span>"));
}

#[test]
fn markdown_constructs_are_styled_and_unsafe_html_stays_text() {
    let Some((temp, w)) = workspace() else { return };
    let out = temp.path().join("markdown");
    build(&w, "markdown.md", &out);
    let html = std::fs::read_to_string(out.join("report.html")).unwrap();
    for tag in [
        "<blockquote>",
        "<hr>",
        "<table>",
        "<pre>",
        "<ul>",
        "<ol>",
        "<del>",
    ] {
        assert!(html.contains(tag), "missing {tag}");
    }
    assert!(html.contains("&lt;iframe") && !html.contains("<iframe"));
    assert!(!html.contains("<details"));
    assert!(html.contains(".text blockquote{"), "blockquotes are styled");
    let (width, height) = png_size(&out.join("report.png"));
    let height = height / SCALE; // the PNG is drawn at 2x; layout heights are in layout pixels
    assert_eq!(width, 840 * SCALE);
    within(height, 950, "markdown fixture");
}

/// The PDF comes from the same pipeline as the HTML, with real selectable text (not a picture of it).
#[test]
fn a_report_builds_a_pdf_whose_text_can_be_selected() {
    let Some((temp, w)) = workspace() else { return };
    let out = temp.path().join("pdf");
    report::build(
        &w,
        &fixture("reports", "markdown.md"),
        &out,
        false,
        false,
        true,
    )
    .unwrap_or_else(|e| panic!("markdown.md should build a pdf: {e:#}"));
    let pdf = out.join("report.pdf");
    let bytes = std::fs::read(&pdf).expect("pdf");
    assert_eq!(&bytes[..5], b"%PDF-");
    let html = std::fs::read_to_string(out.join("report.html")).unwrap();
    assert!(html.contains("<table>"));
    match std::process::Command::new("pdftotext")
        .args([pdf.to_str().unwrap(), "-"])
        .output()
    {
        Ok(output) => {
            assert!(output.status.success());
            let text = String::from_utf8(output.stdout).unwrap();
            let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
            // The heading and the body text of the fixture are in the PDF as text.
            let first_heading = html
                .split("<h1")
                .nth(1)
                .and_then(|rest| rest.split('>').nth(1))
                .and_then(|rest| rest.split('<').next())
                .expect("a heading");
            assert!(
                text.contains(first_heading.trim()),
                "missing {first_heading:?} in {text}"
            );
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            eprintln!("pdftotext unavailable; checked only that the PDF was written");
        }
        Err(error) => panic!("pdftotext: {error}"),
    }
}

/// Every mistake is reported, with its line and a hint, and nothing is rendered.
#[test]
fn broken_reports_name_their_block_line_and_a_fix() {
    let Some((_temp, w)) = workspace() else {
        return;
    };
    let cases: &[(&str, &[&str])] = &[
        (
            "badfield.md",
            &["line 5", "field `nope`", "Its columns: a, b"],
        ),
        (
            "badmark.md",
            &["line 5", "unknown chart mark `barr`", "Did you mean `bar`?"],
        ),
        ("badsql.md", &["line 1", "query `q`", "Parser Error"]),
        (
            "typo.md",
            &[
                "needs `field",
                "unknown key `feild`",
                "Did you mean `field`?",
                "Did you mean `width`?",
            ],
        ),
        ("badwidth.md", &["`width` must be full, half or third"]),
        ("badyaml.md", &["`chart` block", "not valid"]),
        (
            "nofield.md",
            &[
                "`field: zzz` is not a column of query `q`",
                "Its columns: a",
            ],
        ),
        ("dupq.md", &["already defined on line 1"]),
        ("nested-fences.md", &["must be at the top level", "line 45"]),
        ("sqlerr2.md", &["query `q`", "Binder Error", "nope"]),
    ];
    for (name, fragments) in cases {
        let text = std::fs::read_to_string(fixture("broken", name)).unwrap();
        let doc = report::parse(&text).unwrap_or_else(|e| panic!("{name}: {e:#}"));
        let problems = report_check::validate(&doc, Some(&w)).unwrap();
        let summary = report_check::error_summary(&problems)
            .unwrap_or_else(|| panic!("{name} should be rejected, got {problems:?}"));
        for fragment in *fragments {
            assert!(
                summary.contains(fragment),
                "{name}: expected {fragment:?} in\n{summary}"
            );
        }
    }
}

#[test]
fn a_metric_with_two_rows_is_named_when_the_report_is_built() {
    let Some((temp, w)) = workspace() else { return };
    let error = report::build(
        &w,
        &fixture("broken", "twometric.md"),
        &temp.path().join("o"),
        false,
        false,
        false,
    )
    .unwrap_err()
    .to_string();
    assert!(
        error.contains("metric (query `q`) needs exactly one row but the query returned 2"),
        "{error}"
    );
}

#[test]
fn a_query_that_fails_only_at_run_time_is_named() {
    let Some((temp, w)) = workspace() else { return };
    let report_file = temp.path().join("r.md");
    std::fs::write(
        &report_file,
        "```sql fine\nSELECT 1 AS a\n```\n\n```sql boom\nSELECT CAST('abc' AS INTEGER) AS x\n```\n\n```table\nquery: fine\n```\n\n```table\nquery: boom\n```\n",
    )
    .unwrap();
    let error = report::build(
        &w,
        &report_file,
        &temp.path().join("o"),
        false,
        false,
        false,
    )
    .unwrap_err()
    .to_string();
    assert!(
        error.contains("query `boom`") && error.contains("line 5"),
        "{error}"
    );
}

#[test]
fn chart_compilation_warnings_and_empty_transforms_name_their_source() {
    let Some((temp, w)) = workspace() else { return };
    let file = temp.path().join("diagnostics.md");
    std::fs::write(
        &file,
        r#"```sql q
SELECT 1 AS x
```

```chart
query: q
title: Unsupported encoding
spec:
  mark: bar
  encoding:
    x: {field: x, type: quantitative}
    shape: {field: x, type: nominal}
```

```chart
query: q
title: Filtered marks
spec:
  mark: bar
  transform: [{filter: 'datum.x > 10'}]
  encoding:
    x: {field: x, type: quantitative}
```
"#,
    )
    .unwrap();
    let result = report::build(&w, &file, &temp.path().join("out"), false, false, false).unwrap();
    let warnings = result["warnings"]
        .as_array()
        .expect("chart warnings are returned");
    assert!(
        warnings.iter().any(|w| w["block"]
            .as_str()
            .unwrap_or_default()
            .contains("Unsupported encoding")
            && w["line"].is_number()),
        "{result}"
    );
    assert!(
        warnings.iter().any(|w| w["block"]
            .as_str()
            .unwrap_or_default()
            .contains("Filtered marks")
            && w["message"]
                .as_str()
                .unwrap_or_default()
                .contains("no data marks remain after transforms")
            && w["line"].is_number()),
        "{result}"
    );
}

#[test]
fn png_and_pdf_both_render_unsupported_glyphs_with_the_existing_warning() {
    let Some((temp, w)) = workspace() else { return };
    let out = temp.path().join("multilingual");
    let result = report::build(
        &w,
        &fixture("reports", "text-and-charts.md"),
        &out,
        false,
        true,
        true,
    )
    .unwrap();
    assert!(
        result["warnings"].to_string().contains("cannot be drawn"),
        "{result}"
    );
    assert!(
        std::fs::read(out.join("report.pdf"))
            .unwrap()
            .starts_with(b"%PDF-")
    );
    assert_eq!(png_size(&out.join("report.png")).0, 840 * SCALE);
}

#[test]
fn starter_overview_builds_empty_and_on_the_shipped_database() {
    let Some((temp, w)) = workspace() else { return };
    let file = temp.path().join("slurp/reports/overview.md");
    let original = std::fs::read_to_string(&file).unwrap();
    report::build(
        &w,
        &file,
        &temp.path().join("empty-overview"),
        false,
        true,
        false,
    )
    .unwrap();
    let baseline =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/releases/0.2.0/database.duckdb");
    std::fs::copy(baseline, &w.database).unwrap();
    // Bind only this temporary copy to the test workspace; the release fixture stays immutable.
    w.execute(
        "UPDATE _slurp.meta SET backend = 'http://localhost:8080', project = 'prj_fixture'",
        false,
    )
    .unwrap();
    let w = Workspace::load_at(&temp.path().join("private-home"), temp.path()).unwrap();
    assert_eq!(
        w.execute("SELECT slurp_helpers_version() AS v", true)
            .unwrap()[0]["v"],
        slurp_app::helpers::VERSION
    );
    let summary = w.execute("SELECT * FROM slurp_summary", true).unwrap();
    assert_eq!(summary[0]["events"], 2);
    assert_eq!(
        w.execute("SELECT count(*) AS n FROM fixture_labels", true)
            .unwrap()[0]["n"],
        1
    );
    assert_eq!(
        w.execute("SELECT count(*) AS n FROM _slurp.deliveries", true)
            .unwrap()[0]["n"],
        2
    );
    report::build(
        &w,
        &file,
        &temp.path().join("fixture-overview"),
        false,
        true,
        false,
    )
    .unwrap();
    std::fs::write(&file, "# My edited overview").unwrap();
    Workspace::load_at(&temp.path().join("private-home"), temp.path()).unwrap();
    assert_eq!(
        std::fs::read_to_string(&file).unwrap(),
        "# My edited overview"
    );
    assert!(original.contains("slurp_summary"));
}
