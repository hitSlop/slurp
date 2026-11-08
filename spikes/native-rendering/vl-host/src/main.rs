use anyhow::Result;
#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<_> = std::env::args().collect();
    vl_convert_rs::set_font_directories(&[std::path::PathBuf::from(&args[3])])?;
    let converter = vl_convert_rs::VlConverter::new();
    std::fs::create_dir_all(&args[2])?;
    let mut times = Vec::new();
    for entry in std::fs::read_dir(&args[1])? {
        let path = entry?.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let spec: serde_json::Value = serde_json::from_slice(&std::fs::read(&path)?)?;
        let start = std::time::Instant::now();
        let output = converter
            .vegalite_to_svg(spec, Default::default(), Default::default())
            .await?;
        let name = path.file_stem().unwrap().to_str().unwrap();
        times.push(
            serde_json::json!({"case":name,"compile_ms":start.elapsed().as_secs_f64()*1000.,"logs":format!("{:?}",output.logs)}),
        );
        std::fs::write(
            std::path::Path::new(&args[2]).join(format!("{name}.svg")),
            output.svg,
        )?;
    }
    std::fs::write(
        std::path::Path::new(&args[2]).join("timings.json"),
        serde_json::to_vec_pretty(&times)?,
    )?;
    Ok(())
}
