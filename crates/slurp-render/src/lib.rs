//! The app's chart code, embedded once and evaluated only on first chart use.
use resvg::{tiny_skia, usvg};
use rquickjs::{Context, Promise, Runtime};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

mod page;
pub use page::{PAGE_WIDTH, RenderedPage};

const TIMEOUT: Duration = Duration::from_secs(30);
const MAX_INPUT: usize = 32 * 1024 * 1024;
const MAX_PIXELS: u64 = 64 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChartError {
    pub message: String,
}
impl std::fmt::Display for ChartError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for ChartError {}
impl ChartError {
    fn new(message: impl ToString) -> Self {
        Self {
            message: message.to_string(),
        }
    }
}
type Result<T> = std::result::Result<T, ChartError>;

/// The colours a report is drawn in: one of the built-in palettes (see [`palettes`]) or a user's own theme file.
#[derive(Debug, Clone, PartialEq)]
pub struct Theme(Source);
#[derive(Debug, Clone, PartialEq)]
enum Source {
    Builtin(&'static Palette),
    Custom(Arc<Palette>),
}
impl Default for Theme {
    fn default() -> Self {
        Self::light()
    }
}
impl Serialize for Theme {
    /// A built-in theme crosses to the chart engine as its id; a custom one as its full palette.
    fn serialize<S: serde::Serializer>(
        &self,
        serializer: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        match &self.0 {
            Source::Builtin(p) => serializer.serialize_str(&p.id),
            Source::Custom(p) => p.serialize(serializer),
        }
    }
}
impl Theme {
    pub fn light() -> Self {
        Self::named("pro-light").expect("pro-light is built in")
    }
    pub fn dark() -> Self {
        Self::named("pro-dark").expect("pro-dark is built in")
    }
    /// Look a built-in palette up by id; `light` and `dark` are accepted as aliases.
    ///
    /// # Errors
    /// Returns an error naming the valid ids when `id` is not a known palette.
    pub fn named(id: &str) -> Result<Self> {
        let id = match id {
            "light" => "pro-light",
            "dark" => "pro-dark",
            other => other,
        };
        palette(id).map(|p| Self(Source::Builtin(p))).ok_or_else(|| {
            ChartError::new(format!(
                "unknown theme {id}; choose one of: {} (or give the path to a theme .json file)",
                palettes()
                    .iter()
                    .map(|p| p.id.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            ))
        })
    }
    /// Build a theme from the JSON of a user's theme file. See [`custom_palette`] for the format.
    ///
    /// # Errors
    /// Returns an error that names the offending field.
    pub fn custom(definition: &serde_json::Value) -> Result<Self> {
        Ok(Self(Source::Custom(Arc::new(custom_palette(definition)?))))
    }
    pub fn id(&self) -> &str {
        &self.palette().id
    }
    pub fn palette(&self) -> &Palette {
        match &self.0 {
            Source::Builtin(p) => p,
            Source::Custom(p) => p,
        }
    }
}

/// Colours of one theme, shared by the charts and the report page.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Palette {
    pub id: String,
    pub name: String,
    pub scheme: String,
    pub bg: String,
    pub fg: String,
    pub inactive: String,
    pub border: String,
    pub accent: String,
    pub positive: String,
    pub negative: String,
    pub grid: String,
    pub axis_ticks: String,
    pub axis_lines: String,
    pub legend: String,
    pub tooltip_bg: String,
    pub tooltip_fg: String,
    pub series: Vec<String>,
}
/// Every available palette: Perspective's themes plus Slurp's own.
pub fn palettes() -> &'static [Palette] {
    static ALL: std::sync::OnceLock<Vec<Palette>> = std::sync::OnceLock::new();
    ALL.get_or_init(|| {
        serde_json::from_str(include_str!("../assets/themes.json"))
            .expect("the embedded themes are valid")
    })
}
pub fn palette(id: &str) -> Option<&'static Palette> {
    palettes().iter().find(|p| p.id == id)
}

/// A hex colour (`#rgb` or `#rrggbb`) as 0..255 channels.
fn hex(color: &str) -> Option<[f64; 3]> {
    let h = color.strip_prefix('#')?;
    if !h.is_ascii() {
        return None;
    }
    let full: String = match h.len() {
        3 => h.chars().flat_map(|c| [c, c]).collect(),
        6 => h.to_owned(),
        _ => return None,
    };
    let channel = |i: usize| u8::from_str_radix(&full[i..i + 2], 16).ok().map(f64::from);
    Some([channel(0)?, channel(2)?, channel(4)?])
}
/// `weight` of `a` mixed with the rest of `b`, as `#rrggbb`.
fn mix(a: &str, b: &str, weight: f64) -> String {
    let (a, b) = (hex(a).unwrap_or([0.0; 3]), hex(b).unwrap_or([255.0; 3]));
    let c = |i: usize| (a[i] * weight + b[i] * (1.0 - weight)).round() as u8;
    format!("#{:02x}{:02x}{:02x}", c(0), c(1), c(2))
}
fn luminance(color: &str) -> f64 {
    let c = hex(color).unwrap_or([0.0; 3]).map(|v| {
        let v = v / 255.0;
        if v <= 0.04045 {
            v / 12.92
        } else {
            ((v + 0.055) / 1.055).powf(2.4)
        }
    });
    c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722
}

/// WCAG contrast ratio (1 to 21) between two `#rgb` / `#rrggbb` colours; `None` when either is not one of those
/// (built-in themes also use `rgb()` and `white`).
pub fn contrast_ratio(a: &str, b: &str) -> Option<f64> {
    hex(a)?;
    hex(b)?;
    let (la, lb) = (luminance(a), luminance(b));
    Some((la.max(lb) + 0.05) / (la.min(lb) + 0.05))
}

/// Turn a theme file into a full palette.
///
/// Required: `bg`, `fg`, `accent` and `series` (a list of 1 to 20 colours for chart series), unless `extends` names a
/// built-in theme to start from. Everything else is optional and derived from those four: `id`, `name`, `scheme`
/// (`light` or `dark`, from the background), `border`, `inactive`, `grid`, `positive`, `negative`, `axisTicks`,
/// `axisLines`, `legend`, `tooltipBg`, `tooltipFg`. Colours are `#rgb` or `#rrggbb`.
///
/// # Errors
/// Returns an error that names the offending field.
pub fn custom_palette(definition: &serde_json::Value) -> Result<Palette> {
    use serde_json::Value;
    let Some(file) = definition.as_object() else {
        return Err(ChartError::new("a theme file must be a JSON object"));
    };
    let mut fields = match file.get("extends") {
        Some(Value::String(id)) => {
            let base = palette(id.as_str()).or_else(|| match id.as_str() {
                "light" => palette("pro-light"),
                "dark" => palette("pro-dark"),
                _ => None,
            });
            let base = base
                .ok_or_else(|| ChartError::new(format!("extends: unknown built-in theme {id}")))?;
            match serde_json::to_value(base).map_err(ChartError::new)? {
                Value::Object(map) => map,
                _ => unreachable!("a palette is an object"),
            }
        }
        Some(_) => return Err(ChartError::new("extends must be a theme id")),
        None => serde_json::Map::new(),
    };
    let extending = fields.contains_key("bg");
    for (key, value) in file {
        if key != "extends" {
            fields.insert(key.clone(), value.clone());
        }
    }
    let text = |fields: &serde_json::Map<String, Value>, key: &str| {
        fields.get(key).and_then(Value::as_str).map(str::to_owned)
    };
    for key in ["bg", "fg", "accent"] {
        if text(&fields, key).is_none() {
            return Err(ChartError::new(format!(
                "missing {key}: a theme needs bg, fg, accent and series"
            )));
        }
    }
    let series = match fields.get("series") {
        Some(Value::Array(items)) if !items.is_empty() && items.len() <= 20 => items.clone(),
        _ if extending => unreachable!("built-in palettes have series"),
        _ => return Err(ChartError::new("series must be a list of 1 to 20 colours")),
    };
    let (bg, fg, accent) = (
        text(&fields, "bg").unwrap(),
        text(&fields, "fg").unwrap(),
        text(&fields, "accent").unwrap(),
    );
    let first = series[0].as_str().unwrap_or(&accent).to_owned();
    let second = series
        .get(1)
        .and_then(Value::as_str)
        .unwrap_or(&accent)
        .to_owned();
    let scheme = if luminance(&bg) < 0.3 {
        "dark"
    } else {
        "light"
    };
    let name = text(&fields, "name").unwrap_or_else(|| "Custom".into());
    let id = text(&fields, "id").unwrap_or_else(|| {
        let slug: String = name
            .to_lowercase()
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
            .collect();
        format!("custom-{}", slug.trim_matches('-'))
    });
    let derived: [(&str, String); 12] = [
        ("id", id),
        ("name", name),
        ("scheme", scheme.into()),
        ("border", mix(&fg, &bg, 0.15)),
        ("inactive", mix(&fg, &bg, 0.55)),
        ("grid", mix(&fg, &bg, 0.08)),
        ("positive", first),
        ("negative", second),
        ("axisTicks", mix(&fg, &bg, 0.6)),
        ("axisLines", mix(&fg, &bg, 0.25)),
        ("legend", fg.clone()),
        ("tooltipBg", bg.clone()),
    ];
    for (key, value) in derived {
        fields.entry(key).or_insert(Value::String(value));
    }
    fields.entry("tooltipFg").or_insert(Value::String(fg));
    let palette: Palette = serde_json::from_value(Value::Object(fields))
        .map_err(|e| ChartError::new(format!("invalid theme: {e}")))?;
    for (field, color) in [
        ("bg", &palette.bg),
        ("fg", &palette.fg),
        ("inactive", &palette.inactive),
        ("border", &palette.border),
        ("accent", &palette.accent),
        ("positive", &palette.positive),
        ("negative", &palette.negative),
        ("grid", &palette.grid),
        ("axisTicks", &palette.axis_ticks),
        ("axisLines", &palette.axis_lines),
        ("legend", &palette.legend),
        ("tooltipBg", &palette.tooltip_bg),
        ("tooltipFg", &palette.tooltip_fg),
    ]
    .into_iter()
    .chain(palette.series.iter().map(|c| ("series", c)))
    {
        // Only colours the user typed are checked: built-in palettes use other CSS forms (rgb(), hsl(), white).
        let typed = file.contains_key(if field == "series" { "series" } else { field });
        if typed && hex(color).is_none() {
            return Err(ChartError::new(format!(
                "{field}: {color:?} is not a colour; use #rgb or #rrggbb"
            )));
        }
    }
    if !matches!(palette.scheme.as_str(), "light" | "dark") {
        return Err(ChartError::new("scheme must be light or dark"));
    }
    Ok(palette)
}

/// Font family names the renderer knows (also the names to use in report CSS).
pub const SANS: &str = "Geist";
pub const MONO: &str = "Geist Mono";

/// The characters of `text` that the bundled font cannot draw. The PNG and PDF show them as empty boxes (the HTML report is
/// not affected: a browser falls back to the system's fonts). Whitespace and control characters are ignored.
pub fn undrawable_chars(text: &str, font: &str) -> Vec<char> {
    use skrifa::{FontRef, MetadataProvider};
    let bytes: &[u8] = if font == MONO {
        include_bytes!("../assets/GeistMonoVariable.ttf")
    } else {
        include_bytes!("../assets/GeistVariable.ttf")
    };
    let Ok(face) = FontRef::new(bytes) else {
        return vec![];
    };
    let charmap = face.charmap();
    let mut missing: Vec<char> = text
        .chars()
        .filter(|c| !c.is_whitespace() && !c.is_control() && charmap.map(*c).is_none())
        .collect();
    missing.sort_unstable();
    missing.dedup();
    missing
}

#[derive(Debug, Clone, Serialize)]
pub struct CompileOptions {
    pub theme: Theme,
    /// Font family used for chart text.
    pub font: String,
    pub width: u32,
    pub height: u32,
}
impl Default for CompileOptions {
    fn default() -> Self {
        Self {
            theme: Theme::light(),
            font: SANS.into(),
            width: 640,
            height: 260,
        }
    }
}
#[derive(Debug, Deserialize)]
pub struct CompiledChart {
    pub svg: String,
    pub warnings: Vec<String>,
    #[serde(rename = "emptyData", default)]
    pub empty_data: Vec<String>,
}
#[derive(Deserialize)]
#[serde(untagged)]
enum Output {
    Chart(CompiledChart),
    Error { error: String },
}

struct Engine {
    // Context must be dropped before its runtime.
    context: Context,
    runtime: Runtime,
    deadline: Arc<Mutex<Instant>>,
}
impl Engine {
    fn new() -> Result<Self> {
        let runtime = Runtime::new().map_err(ChartError::new)?;
        runtime.set_memory_limit(256 * 1024 * 1024);
        runtime.set_max_stack_size(2 * 1024 * 1024);
        let deadline = Arc::new(Mutex::new(Instant::now() + TIMEOUT));
        let clock = deadline.clone();
        runtime.set_interrupt_handler(Some(Box::new(move || {
            Instant::now() >= *clock.lock().unwrap()
        })));
        let context = Context::full(&runtime).map_err(ChartError::new)?;
        let bundle = zstd::decode_all(&include_bytes!("../assets/render.js.zst")[..])
            .map_err(ChartError::new)?;
        context
            .with(|ctx| ctx.eval::<(), _>(bundle))
            .map_err(ChartError::new)?;
        Ok(Self {
            context,
            runtime,
            deadline,
        })
    }
    fn page(&self, input: &str) -> Result<String> {
        *self.deadline.lock().unwrap() = Instant::now() + TIMEOUT;
        self.context.with(|ctx| {
            ctx.globals()
                .set("inputJSON", input)
                .map_err(ChartError::new)?;
            ctx.eval("slurpChart.page(...JSON.parse(inputJSON))")
                .map_err(|e| {
                    let exception = ctx.catch();
                    ChartError::new(
                        exception
                            .as_exception()
                            .and_then(|e| e.message())
                            .unwrap_or_else(|| e.to_string()),
                    )
                })
        })
    }
    fn compile(&self, input: &str) -> Result<Output> {
        *self.deadline.lock().unwrap() = Instant::now() + TIMEOUT;
        self.context.with(|ctx| {
            let run = || -> rquickjs::Result<String> {
                ctx.globals().set("inputJSON", input)?;
                let promise: Promise = ctx.eval("(async () => { const {spec,result,opts} = JSON.parse(inputJSON); return JSON.stringify(await slurpChart.compile(spec,result,opts)); })()")?;
                loop {
                    if Instant::now() >= *self.deadline.lock().unwrap() { return Err(rquickjs::Error::WouldBlock); }
                    if let Some(result) = promise.result::<String>() { return result; }
                    if !ctx.execute_pending_job() { return Err(rquickjs::Error::WouldBlock); }
                }
            };
            let output = run().map_err(|e| {
                if Instant::now() >= *self.deadline.lock().unwrap() {
                    ChartError::new("chart execution exceeded 30 seconds")
                } else {
                    let exception = ctx.catch();
                    let message = exception.as_exception().and_then(|e| e.message()).unwrap_or_else(|| e.to_string());
                    ChartError::new(message)
                }
            })?;
            serde_json::from_str(&output).map_err(ChartError::new)
        })
    }
}

/// Reuse this handle for all charts in an invocation. Construction does no JS/font work.
#[derive(Default)]
pub struct ChartRenderer {
    engine: Option<Engine>,
    fonts: Option<Arc<fontdb::Database>>,
    page_fonts: Option<takumi::prelude::Fonts>,
}
impl ChartRenderer {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn compile(
        &mut self,
        spec: &Value,
        result: &impl Serialize,
        opts: CompileOptions,
    ) -> Result<CompiledChart> {
        if opts.width == 0 || opts.height == 0 || opts.width > 4096 || opts.height > 4096 {
            return Err(ChartError::new(
                "chart width and height must be between 1 and 4096",
            ));
        }
        let input =
            serde_json::to_string(&serde_json::json!({"spec":spec,"result":result,"opts":opts}))
                .map_err(ChartError::new)?;
        if input.len() > MAX_INPUT {
            return Err(ChartError::new("chart input exceeds 32 MiB"));
        }
        if self.engine.is_none() {
            self.engine = Some(Engine::new()?);
        }
        match self.engine.as_ref().unwrap().compile(&input) {
            Ok(Output::Chart(chart)) => {
                self.engine.as_ref().unwrap().runtime.run_gc();
                Ok(chart)
            }
            Ok(Output::Error { error }) => Err(ChartError::new(error)),
            Err(error) => {
                // Interrupted/OOM hosts may retain pending jobs; rebuild only after host failures.
                self.engine = None;
                Err(error)
            }
        }
    }
    /// Reuse the same bounded QuickJS host for chart compilation and page HTML.
    pub fn page_html(
        &mut self,
        definition: &impl Serialize,
        run: &impl Serialize,
        charts: &impl Serialize,
        theme: Theme,
    ) -> Result<String> {
        let input =
            serde_json::to_string(&(definition, run, charts, theme)).map_err(ChartError::new)?;
        if input.len() > MAX_INPUT {
            return Err(ChartError::new("page input exceeds 32 MiB"));
        }
        if self.engine.is_none() {
            self.engine = Some(Engine::new()?);
        }
        let result = self.engine.as_ref().unwrap().page(&input);
        if result.is_err() {
            self.engine = None;
        } else {
            self.engine.as_ref().unwrap().runtime.run_gc();
        }
        result
    }
    pub fn render_page(&mut self, html: &str, png: bool, pdf: bool) -> Result<RenderedPage> {
        if self.page_fonts.is_none() {
            self.page_fonts = Some(page::fonts()?);
        }
        page::render(html, self.page_fonts.as_ref().unwrap(), png, pdf)
    }
    pub fn to_png(&mut self, svg: &str, scale: f32) -> Result<Vec<u8>> {
        validate_scale(scale)?;
        let fonts = self.fonts.get_or_insert_with(|| {
            let mut db = fontdb::Database::new();
            db.load_font_data(include_bytes!("../assets/GeistVariable.ttf").to_vec());
            db.load_font_data(include_bytes!("../assets/GeistMonoVariable.ttf").to_vec());
            db.load_system_fonts();
            db.set_sans_serif_family("Geist");
            Arc::new(db)
        });
        let options = usvg::Options {
            font_family: "Geist".into(),
            fontdb: fonts.clone(),
            image_href_resolver: usvg::ImageHrefResolver {
                resolve_data: Box::new(|_, _, _| None),
                resolve_string: Box::new(|_, _| None),
            },
            ..usvg::Options::default()
        };
        let tree = usvg::Tree::from_str(svg, &options).map_err(ChartError::new)?;
        let width = (tree.size().width() * scale).ceil() as u32;
        let height = (tree.size().height() * scale).ceil() as u32;
        if u64::from(width) * u64::from(height) > MAX_PIXELS {
            return Err(ChartError::new("chart image exceeds 64 megapixels"));
        }
        let mut pixmap = tiny_skia::Pixmap::new(width, height)
            .ok_or_else(|| ChartError::new("invalid chart image dimensions"))?;
        resvg::render(
            &tree,
            tiny_skia::Transform::from_scale(scale, scale),
            &mut pixmap.as_mut(),
        );
        pixmap.encode_png().map_err(ChartError::new)
    }
}
pub fn validate_scale(scale: f32) -> Result<()> {
    if !scale.is_finite() || scale <= 0.0 || scale > 16.0 {
        return Err(ChartError::new(
            "scale must be greater than 0 and at most 16",
        ));
    }
    Ok(())
}
pub fn versions() -> Value {
    serde_json::from_str(include_str!("../assets/versions.json")).expect("generated versions")
}
/// Vega emits numeric root width/height attributes. These include axes and legends.
pub fn dimensions(svg: &str) -> Result<(u32, u32)> {
    let root = svg.split('>').next().unwrap_or_default();
    let attr = |key| -> Result<u32> {
        let value = root
            .split(&format!(" {key}=\""))
            .nth(1)
            .and_then(|v| v.split('"').next())
            .ok_or_else(|| ChartError::new("SVG dimensions missing"))?;
        let n: f32 = value.parse().map_err(ChartError::new)?;
        if !n.is_finite() || n <= 0.0 || n > 65536.0 {
            return Err(ChartError::new("invalid SVG dimensions"));
        }
        Ok(n.ceil() as u32)
    };
    Ok((attr("width")?, attr("height")?))
}

#[cfg(test)]
mod tests {
    #[test]
    fn characters_outside_the_bundled_fonts_are_reported() {
        assert!(super::undrawable_chars("Ünïcödé café – 12.5% → ok", super::MONO).is_empty());
        assert_eq!(
            super::undrawable_chars("日本 hello 日", super::SANS),
            vec!['日', '本']
        );
        assert!(super::undrawable_chars("   \n", super::SANS).is_empty());
    }
    use super::*;
    #[test]
    fn lazy_host_has_no_io_and_interrupts() {
        let renderer = ChartRenderer::new();
        assert!(
            renderer.engine.is_none() && renderer.fonts.is_none() && renderer.page_fonts.is_none()
        );
        let engine = Engine::new().unwrap();
        engine.context.with(|ctx| {
            let capabilities: String = ctx.eval("JSON.stringify(['fetch','require','process','document','console','readFile','loadFile'].map(k=>typeof globalThis[k]))").unwrap();
            assert_eq!(capabilities, r#"["undefined","undefined","undefined","undefined","undefined","undefined","undefined"]"#);
            let promise: Promise = ctx.eval("(async()=>{ const a=[]; const id=setTimeout(()=>a.push('cancelled'),0); clearTimeout(id); setTimeout(()=>a.push('first'),99); await Promise.resolve(); const c=structuredClone({a:[1,null,'x']}); return JSON.stringify({a,c}); })()").unwrap();
            let value: String = promise.finish().unwrap();
            assert_eq!(value, r#"{"a":["first"],"c":{"a":[1,null,"x"]}}"#);
            *engine.deadline.lock().unwrap() = Instant::now() - Duration::from_millis(1);
            assert!(ctx.eval::<(),_>("for (;;) {}").is_err());
            ctx.catch();
        });
    }
}
