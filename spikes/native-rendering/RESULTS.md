# Native rendering spike results

Recommendation: keep Vega-Lite and Takumi, integrate the complete DPR correction through a pinned dependency, and remove Slurp's SVG string rewriting. The corrected native path passed the geometry probes, preserved vector PDF charts, and composed faster than the raster alternatives in this corpus. Do not treat this spike as a production migration or a universal rendering guarantee.

The initial preference was resvg composition. The completed comparison supports the smaller native correction instead. resvg remains a credible alternative if subsequent supported-SVG fixtures expose additional Takumi problems.

## Final measurements

macOS release builds; 27 chart cases; three composition renders per case; medians use the last two samples. Final measurements ran after builds completed. These are short, single-machine exploratory samples, not performance guarantees. Compilation and chart preparation are separate from composition.

| Candidate | Geometry probes | Compiler median | Chart preparation median | Composition median | Process peak RSS | PDF charts |
|---|---|---:|---:|---:|---:|---|
| baseline | 1/3 | 38.25 ms | 0.00 ms | 21.25 ms | 281.8 MiB | Vector |
| patched | 3/3 | 27.06 ms | 0.00 ms | 12.46 ms | 276.4 MiB | Vector |
| resvg2 | 3/3 | 25.63 ms | 11.57 ms | 20.75 ms | 265.3 MiB | Raster |
| resvg4 | 3/3 | 34.06 ms | 40.82 ms | 87.46 ms | 496.1 MiB | Raster |
| vl-resvg2 | 3/3 | 8.67 ms | 12.61 ms | 21.56 ms | 260.9 MiB | Raster |

The vl-convert compiler is measured separately from composition: the composition host still runs QuickJS for baseline diagnostics before substituting its SVG. Its compiler process peaked at approximately 114 MiB RSS; the table's vl-resvg2 RSS is the separate composition process. Do not sum these as concurrent memory use. The vl-convert compiler host executable is approximately 163 MiB; common rendering hosts are approximately 18 MiB and include all branches/resvg. These are executable sizes, not measured Slurp production binary deltas. Its cold build took 24m12s and resolved 953 packages.

## Correctness evidence

- Existing renderer tests: 13 passed. Existing CLI report fixture tests: 7 passed using DuckDB 2.0.0. An initial invocation with DuckDB 1.4.3 failed at setup and was rerun with the correct executable.
- 21 existing chart fixtures plus six width/font/theme variants rendered to SVG, HTML, PNG and PDF. Each individual PNG was byte-identical across three consecutive renders in each candidate.
- Baseline fails CSS-sized translated paths and equivalent single-quoted SVG. Corrected Takumi, resvg2 and resvg4 pass all three geometry probes.
- The partial Takumi backport failed all three probes. The complete patch also converts style sizing to CSS pixels before applying DPR. Four source files are affected. The failed partial outputs are retained under patched-partial for investigation.
- Final sizing is consistent across candidates: per-chart HTML includes the report template's max-width/auto-height SVG rule. Earlier images without this rule are exploratory and must not be used for the final call. A reported clipped axis title was from those earlier images; final title crops confirm complete text.
- Actual PNG chart contact sheets and representative area/bar PDFs were inspected. Poppler reports no embedded images in the patched vector chart PDF; resvg2 embeds the chart at 192 ppi. The gallery PDF includes END OF REPORT.
- Chromium was used as a development reference with the same embedded font files, not as a runtime dependency. It was a representative comparison, not an exhaustive browser parity test.
- vl-convert compiled all 27 shared chart cases and two font probes without warning/error logs. Narrow i labels and wide W labels produce SVG widths 244 and 322 respectively, compared with the custom host's identical 307 widths from the earlier audit. Font measurement is a real remaining improvement.
- The pinned vl-convert version is 2.0.0-rc7 and uses Vega-Lite 6.4.3, while Slurp uses 6.5.0. Differences are not a controlled font-only experiment.

## Production follow-up and limits

Integrate the complete pinned Takumi patch, remove fit_svgs_to_density, and retain the geometry and real-chart regressions. Separately add accurate bundled-font measurements to Vega and propagate warnings/empty transformed data into report diagnostics. Neither resvg nor a DPR patch fixes upstream text-layout estimates.

Do not adopt vl-convert by default for this CLI now: it adds a substantial runtime footprint, is a prerelease, and does not match the currently embedded Vega-Lite version. It is a useful font-layout reference.

Keep external chart styling and chart dimensions explicit if adopting a resvg asset boundary later; SVG images cannot inherit page CSS. Raster PDF tradeoffs were acceptable for the experiment, but the native winner retains vectors without that tradeoff.

Remaining qualification includes Linux execution, more real report templates/adjacent half-and-third layout exports, exhaustive marks/gradients/clips, unsupported-script coverage, and process-level hostile-input memory/time limits for the alternative hosts. Existing CLI tests cover author errors, unsupported glyph warnings and hostile layouts on the production path; they do not qualify each experimental adapter. Production binary-size deltas have not been built. The spike harness intentionally is not production code.

## Review and reproduction

Run `python3 spikes/native-rendering/run.py` to build/run all candidates. Run `python3 spikes/native-rendering/benchmark.py` to reuse completed binaries without compiler contention. `target/native-rendering-results/comparison.html` contains the review page; summary.json, per-case measurements.json, compiler timings.json, and resource logs contain raw evidence. See README.md for dependencies and version caveats.
