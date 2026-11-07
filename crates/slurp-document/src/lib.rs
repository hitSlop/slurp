//! Report prose to HTML, in Rust (spike S7 scope addition): one Markdown implementation for the
//! app viewer and the PNG/PDF export, so prose cannot differ between them.
//!
//! Matches markdown-it's default preset as the viewers used it (`html: false`, tables and
//! strikethrough on, linkify and typographer off), with `{param}` substitution on text only:
//! code spans and code blocks stay literal, like `renderMarkdownParams` did.
//!
//! **Sanitizing.** pulldown-cmark passes raw HTML through and does not filter URLs, so:
//! - raw HTML (block or inline) is rendered as escaped text, which is what markdown-it with
//!   `html: false` shows (Markdown reports already reject it at apply, except comments, which
//!   lowering strips);
//! - links keep their `<a>` only for `http`, `https`, `mailto`, relative paths and `#`
//!   anchors; otherwise only the link text is shown;
//! - images keep `src` only for `http`, `https` and `data:image/(gif|png|jpeg|webp)`;
//!   otherwise only the alt text is shown.
//!
//! The HTML writer escapes all text and attribute values, so with raw HTML neutralized, URLs
//! are the only remaining injection surface. `ammonia` then cleans the output again with the
//! [`ALLOWED`] elements and attributes and the same URL rules, as a backstop.
//!
//! [`ALLOWED`] is also the styling contract: every allowed element has a `.prose` rule in the
//! app CSS and in `page.ts` (tested), so prose looks the same and stays within takumi's CSS.
use pulldown_cmark::{CowStr, Event, Options, Parser, Tag, TagEnd, TextMergeStream};
use serde::Serialize;
use serde_json::{Map, Value};

/// The only elements and attributes report prose may contain (ammonia allowlist and styling
/// contract). URL attributes are further limited by [`safe_link`] and [`safe_image`].
pub const ALLOWED: &[(&str, &[&str])] = &[
    ("p", &[]),
    ("h1", &[]),
    ("h2", &[]),
    ("h3", &[]),
    ("h4", &[]),
    ("ul", &[]),
    ("ol", &[]),
    ("li", &[]),
    ("strong", &[]),
    ("em", &[]),
    ("del", &[]),
    ("code", &[]),
    ("pre", &[]),
    ("blockquote", &[]),
    ("a", &["href", "title"]),
    ("img", &["src", "alt"]),
    ("table", &[]),
    ("thead", &[]),
    ("tbody", &[]),
    ("tr", &[]),
    ("th", &["align"]),
    ("td", &["align"]),
    ("hr", &[]),
    ("br", &[]),
];

/// ammonia with exactly [`ALLOWED`]; links and images pass the same URL checks again.
fn sanitize(html: &str) -> String {
    use std::collections::{HashMap, HashSet};
    let tags: HashSet<&str> = ALLOWED.iter().map(|(t, _)| *t).collect();
    let attributes: HashMap<&str, HashSet<&str>> = ALLOWED
        .iter()
        .filter(|(_, a)| !a.is_empty())
        .map(|(t, a)| (*t, a.iter().copied().collect()))
        .collect();
    ammonia::Builder::empty()
        .tags(tags)
        .tag_attributes(attributes)
        .url_schemes(["http", "https", "mailto", "data"].into_iter().collect())
        .url_relative(ammonia::UrlRelative::PassThrough)
        .link_rel(None)
        .attribute_filter(|element, attribute, value| match (element, attribute) {
            ("a", "href") if !safe_link(value) => None,
            ("img", "src") if !safe_image(value) => None,
            ("th" | "td", "align") if !["left", "center", "right"].contains(&value) => None,
            _ => Some(value.into()),
        })
        .clean(html)
        .to_string()
}

/// markdown-it's default preset, as far as pulldown-cmark has equivalents.
pub fn options() -> Options {
    Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH
}

fn scheme(url: &str) -> Option<String> {
    let colon = url.find(':')?;
    let head = &url[..colon];
    if url[..colon].contains(['/', '?', '#']) || head.is_empty() {
        return None;
    }
    head.chars()
        .all(|c| c.is_ascii_alphanumeric() || "+.-".contains(c))
        .then(|| head.to_ascii_lowercase())
}

/// Browsers ignore ASCII whitespace and control characters inside a scheme (`java\tscript:`).
fn normalized(url: &str) -> String {
    url.chars().filter(|c| *c as u32 > 0x20).collect()
}

pub fn safe_link(url: &str) -> bool {
    match scheme(&normalized(url)) {
        None => true,
        Some(s) => ["http", "https", "mailto"].contains(&s.as_str()),
    }
}

pub fn safe_image(url: &str) -> bool {
    let url = normalized(url);
    match scheme(&url).as_deref() {
        Some("http" | "https") => true,
        Some("data") => {
            let lower = url.to_ascii_lowercase();
            ["gif", "png", "jpeg", "webp"].iter().any(|t| {
                lower.starts_with(&format!("data:image/{t};"))
                    || lower.starts_with(&format!("data:image/{t},"))
            })
        }
        _ => false,
    }
}

/// HTML produced by [`render`] and nothing else: the only value a viewer may insert unescaped.
/// It serializes as a string but never deserializes, so HTML read back from a file (for example
/// `report render --from-run`) is never trusted; prose is rendered again from its Markdown.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(transparent)]
pub struct SafeHtml(String);
impl SafeHtml {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Render one prose segment. `{param}` values are substituted on parsed text events only, as
/// literal text (a value of `*Acme*` shows those characters); code spans, code blocks and link
/// destinations are never substituted.
pub fn render(text: &str, params: &Map<String, Value>) -> SafeHtml {
    let mut events: Vec<Event> = vec![];
    let mut code_block = false;
    // Whether each open link/image kept its tag.
    let mut kept: Vec<bool> = vec![];
    for event in TextMergeStream::new(Parser::new_ext(text, options())) {
        match event {
            Event::Start(Tag::CodeBlock(kind)) => {
                code_block = true;
                events.push(Event::Start(Tag::CodeBlock(kind)));
            }
            Event::End(TagEnd::CodeBlock) => {
                code_block = false;
                events.push(Event::End(TagEnd::CodeBlock));
            }
            Event::Text(t) if !code_block => {
                events.push(Event::Text(CowStr::from(substitute_title(&t, params))));
            }
            Event::Start(Tag::Link {
                link_type,
                dest_url,
                title,
                id,
            }) => {
                let ok = safe_link(&dest_url);
                kept.push(ok);
                if ok {
                    events.push(Event::Start(Tag::Link {
                        link_type,
                        dest_url,
                        title,
                        id,
                    }));
                }
            }
            Event::End(TagEnd::Link) => {
                if kept.pop().unwrap_or(false) {
                    events.push(Event::End(TagEnd::Link));
                }
            }
            Event::Start(Tag::Image {
                link_type,
                dest_url,
                title,
                id,
            }) => {
                let ok = safe_image(&dest_url);
                kept.push(ok);
                if ok {
                    events.push(Event::Start(Tag::Image {
                        link_type,
                        dest_url,
                        title,
                        id,
                    }));
                }
            }
            Event::End(TagEnd::Image) => {
                if kept.pop().unwrap_or(false) {
                    events.push(Event::End(TagEnd::Image));
                }
            }
            // markdown-it with `html: false` shows raw HTML as text; an HTML block becomes a
            // paragraph of text.
            Event::Start(Tag::HtmlBlock) => events.push(Event::Start(Tag::Paragraph)),
            Event::End(TagEnd::HtmlBlock) => {
                if let Some(Event::Text(t)) = events.last_mut() {
                    *t = CowStr::from(t.trim_end_matches('\n').to_string());
                }
                events.push(Event::End(TagEnd::Paragraph))
            }
            Event::Html(h) | Event::InlineHtml(h) => {
                let h = substitute_title(&h, params);
                match events.last_mut() {
                    Some(Event::Text(t)) => *t = CowStr::from(format!("{t}{h}")),
                    _ => events.push(Event::Text(CowStr::from(h))),
                }
            }
            other => events.push(other),
        }
    }
    let mut html = String::new();
    pulldown_cmark::html::push_html(&mut html, events.into_iter());
    // pulldown writes table alignment as a style attribute; the allowlist has `align` only.
    for side in ["left", "center", "right"] {
        html = html.replace(
            &format!(" style=\"text-align: {side}\""),
            &format!(" align=\"{side}\""),
        );
    }
    SafeHtml(sanitize(&html))
}

/// One pass: braces inside a parameter value remain literal.
pub fn substitute_title(text: &str, params: &Map<String, Value>) -> String {
    let mut output = String::new();
    let mut copied = 0;
    let mut open = None;
    for (i, ch) in text.char_indices() {
        if ch == '{' {
            open = Some(i);
        } else if ch == '}'
            && let Some(start) = open.take()
            && i > start + 1
        {
            output.push_str(&text[copied..start]);
            match params.get(&text[start + 1..i]) {
                Some(Value::String(s)) => output.push_str(s),
                Some(Value::Null) => output.push('—'),
                Some(v) => output.push_str(&v.to_string()),
                None => output.push_str(&text[start..=i]),
            }
            copied = i + 1;
        }
    }
    output.push_str(&text[copied..]);
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn param_values_are_literal_text() {
        let params =
            json!({"name": "*Acme* [x](javascript:alert(1)) <b>", "url": "https://evil.test"})
                .as_object()
                .unwrap()
                .clone();
        let html = render(
            "Client {name}.\n\n[link text {name}](https://ok.test/{url}) and `{name}`\n\n    {name}\n",
            &params,
        );
        let html = html.as_str();
        // No emphasis, no link and no tag come from a value.
        assert!(
            html.contains("Client *Acme* [x](javascript:alert(1)) &lt;b&gt;."),
            "{html}"
        );
        assert!(
            !html.contains("<em>") && !html.contains("javascript:alert(1)\""),
            "{html}"
        );
        // Link destinations are never substituted; link text is.
        assert!(
            html.contains(r#"<a href="https://ok.test/%7Burl%7D">link text *Acme*"#),
            "{html}"
        );
        // Code spans and indented code blocks stay literal.
        assert!(html.contains("<code>{name}</code>"), "{html}");
        assert!(html.contains("<pre><code>{name}\n</code></pre>"), "{html}");
    }

    #[test]
    fn javascript_links_script_and_onerror_are_neutralized() {
        let html = render(
            "[ok](https://x.test/a?b=1) [mail](mailto:a@b.test) [rel](./x) [anchor](#top)\n\n[bad](javascript:alert(1)) [bad2](JaVa\tScRiPt:alert(1)) [bad3](&#106;avascript:alert(1)) [v](vbscript:x) [d](data:text/html,<script>alert(1)</script>)\n\n<script>alert(1)</script>\n\nInline <img src=x onerror=alert(1)> html.\n\n![pic](https://x.test/p.png) ![svg](data:image/svg+xml;base64,PHN2Zz4=) ![png](data:image/png;base64,iVBOR) ![js](javascript:alert(1))\n",
            &Map::new(),
        );
        let html = html.as_str();
        for ok in [
            r#"<a href="https://x.test/a?b=1">ok</a>"#,
            r#"<a href="mailto:a@b.test">mail</a>"#,
            r#"<a href="./x">rel</a>"#,
            r##"<a href="#top">anchor</a>"##,
            r#"<img src="https://x.test/p.png" alt="pic">"#,
            r#"<img src="data:image/png;base64,iVBOR" alt="png">"#,
        ] {
            assert!(html.contains(ok), "missing {ok}:\n{html}");
        }
        let lower = html.to_ascii_lowercase();
        assert!(!lower.contains("javascript:"), "{html}");
        assert!(
            !lower.contains("vbscript:") && !lower.contains("data:text"),
            "{html}"
        );
        assert!(
            !lower.contains("<script") && !lower.contains("<img src=x"),
            "{html}"
        );
        assert!(
            html.contains("&lt;script&gt;alert(1)&lt;/script&gt;"),
            "{html}"
        );
        assert!(
            html.contains("Inline &lt;img src=x onerror=alert(1)&gt; html."),
            "{html}"
        );
        assert!(!html.contains("svg+xml"), "{html}");
        // The text of a dropped link or image still shows.
        assert!(html.contains("bad") && html.contains("js"), "{html}");
    }

    /// Tags, attributes and URLs found in rendered HTML (text is escaped, so every `<` opens a tag).
    fn tags(html: &str) -> Vec<(String, Vec<(String, String)>)> {
        let mut out = vec![];
        for part in html.split('<').skip(1) {
            let tag = part.split('>').next().unwrap_or("");
            let mut words = tag.trim_end_matches('/').split_whitespace();
            let name = words
                .next()
                .unwrap_or("")
                .trim_start_matches('/')
                .to_ascii_lowercase();
            let rest = tag[name.len().min(tag.len())..].to_string();
            let mut attrs = vec![];
            for chunk in rest.split('"').collect::<Vec<_>>().chunks(2) {
                if let [key, value] = chunk {
                    let key = key.trim().trim_end_matches('=').trim().to_ascii_lowercase();
                    let value = value.replace("&amp;", "&");
                    attrs.push((key, value));
                }
            }
            out.push((name, attrs));
        }
        out
    }

    fn piece() -> impl proptest::strategy::Strategy<Value = String> {
        use proptest::prelude::*;
        prop_oneof![
            Just("[x](javascript:alert(1))".to_string()),
            Just("[x]( JaVaScRiPt:alert(1))".to_string()),
            Just("[e](&#x6A;avascript:alert(1))".to_string()),
            Just("[v](vbscript:msgbox)".to_string()),
            Just("[d](data:text/html,<script>alert(1)</script>)".to_string()),
            Just("![s](data:image/svg+xml;base64,PHN2Zz4=)".to_string()),
            Just("![ok](data:image/png;base64,AAAA)".to_string()),
            Just("![rel](./local.png)".to_string()),
            Just("[ok](https://ok.test/a?b=1&c=2)".to_string()),
            Just("<script>alert(1)</script>".to_string()),
            Just("<style>*{color:red}</style>".to_string()),
            Just("<img src=x onerror=alert(1)>".to_string()),
            Just("<a href='javascript:x' onclick=\"y\">a</a>".to_string()),
            Just("<svg onload=alert(1)>".to_string()),
            Just("<iframe src=https://x.test>".to_string()),
            Just("<!-- c -->".to_string()),
            Just("| a | b |\n|:-|-:|\n| <b onclick=x> | [l](javascript:1) |\n".to_string()),
            Just("**bold** _em_ ~~del~~ `code {p}`".to_string()),
            Just("{p}".to_string()),
            Just("\n\n".to_string()),
            Just("\n```\n<script>\n```\n".to_string()),
            Just("> quote <b>\n".to_string()),
            "[ -~]{0,12}".prop_map(|s| s),
        ]
    }

    proptest::proptest! {
        #![proptest_config(proptest::prelude::ProptestConfig::with_cases(400))]
        #[test]
        fn rendered_prose_never_contains_active_content(
            pieces in proptest::collection::vec(piece(), 1..14),
            value in "[ -~]{0,24}",
        ) {
            let text = pieces.join(" ");
            let mut params = Map::new();
            params.insert("p".into(), json!(format!("<script>{value}</script>[x](javascript:1)")));
            let html = render(&text, &params);
            for (name, attrs) in tags(html.as_str()) {
                let allowed = ALLOWED.iter().find(|(t, _)| *t == name);
                proptest::prop_assert!(allowed.is_some(), "element <{}> in {}", name, html.as_str());
                for (key, value) in attrs {
                    proptest::prop_assert!(!key.starts_with("on"), "{} in {}", key, html.as_str());
                    proptest::prop_assert!(allowed.unwrap().1.contains(&key.as_str()), "{}={} on {}", key, value, name);
                    if key == "href" {
                        proptest::prop_assert!(safe_link(&value), "href {}", value);
                        let v = value.to_ascii_lowercase();
                        proptest::prop_assert!(!v.contains("javascript:") && !v.contains("vbscript:") && !v.starts_with("data:"), "href {}", value);
                    }
                    if key == "src" {
                        let v = value.to_ascii_lowercase();
                        proptest::prop_assert!(
                            v.starts_with("http://") || v.starts_with("https://")
                                || ["gif", "png", "jpeg", "webp"].iter().any(|t| v.starts_with(&format!("data:image/{t}"))),
                            "src {}", value
                        );
                    }
                }
            }
            let lower = html.as_str().to_ascii_lowercase();
            proptest::prop_assert!(!lower.contains("<script") && !lower.contains("<style"));
        }
    }
}
