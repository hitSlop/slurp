//! Report layout and authoring-error regression tests. The fixtures are deliberately hostile: long unbroken text, wide tables,
//! non-Latin text, empty results, 1,000-point charts, and every kind of mistake an author can make.
use slurp_app::{Workspace, report, report_check};
use std::path::{Path, PathBuf};

fn workspace() -> Option<(tempfile::TempDir, Workspace)> {
    let exe = std::env::var_os("SLURP_TEST_DUCKDB")?;
    let temp = tempfile::tempdir().expect("test directory");
    let w = Workspace::init(
        temp.path(),
        "http://localhost:8080".into(),
        "src_fixture".into(),
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
    assert_eq!(width, 840);
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
        !html.contains("<script"),
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
    assert_eq!(width, 840);
    within(height, 2170, "text and charts fixture");
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
    assert_eq!(width, 840);
    within(height, 950, "markdown fixture");
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
