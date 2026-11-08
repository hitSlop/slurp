# Native report rendering comparison

Experimental harness only. Production crates and APIs are unchanged.

Run from the repository root:

```sh
python3 spikes/native-rendering/run.py
```

The runner builds release binaries, saves results under `target/native-rendering-results`, and compares:

- `baseline`: current production SVG-to-image workaround.
- `patched`: registry Takumi core 0.35.0 with the adjacent narrow DPR patch; inline SVG with no Slurp rewrite.
- `resvg2`, `resvg4`: current QuickJS compiler, bundled fonts, resvg 0.49.0 chart images, then production Takumi composition. PDF charts are raster images.
- `vl-resvg2`: vl-convert-rs 2.0.0-rc7 compilation of the same prepared chart specifications, followed by the resvg pipeline.

Both manifests have isolated workspaces and lockfiles. The patch is applied to a copy of the cached registry source in the results directory. No local Takumi checkout is a build dependency. The runner uses macOS `time -l` or Linux `time -v` and requires Node on PATH. This run was validated on macOS only. The builds need network access to fetch dependencies on first use. The checked-in lockfiles pin both workspaces.

Each case saves SVG, HTML, PNG, PDF, compiler warnings, and timing samples. SVG compilation and chart preparation are recorded separately from three composition samples. The first compilation includes cold host initialization; subsequent charts reuse the host. This is exploratory timing, not a statistically controlled production benchmark. Executable sizes describe the spike hosts, not final Slurp binary deltas: the common host includes all branches and resvg.

The corpus contains 21 existing chart fixtures plus six narrow-width/theme/font variants. Gallery outputs check document height and chart stacking. Pixel probes check a translated path, CSS sizing, and equivalent quoting. These probes are necessary but not sufficient: inspect actual charts and rasterized PDFs before selecting a renderer. External page CSS affecting chart internals is outside the resvg asset-boundary contract.

`prepare.mjs` calls the existing chart preparation/theme functions without writing the checked-in bundle. The vl-convert composition timings still run QuickJS to obtain baseline diagnostics; use `vl-svg/timings.json` for the alternative compiler's own timings. Do not compare that redundant host work as final production startup cost.

Generate the review page after a completed run:

```sh
python3 spikes/native-rendering/summarize.py
```

Open `target/native-rendering-results/comparison.html`. Inspect `gallery.pdf` and `gallery.png` in each candidate directory for document completeness. `checks.json` records pass/fail geometry probes; baseline failures are intentional controls. Each chart's PNG must be byte-identical across its three render samples, or the host fails the run. `font-probe-i.svg` and `font-probe-w.svg` in `vl-svg/` expose the alternative compiler's font-aware layout.

For visual PDF QA, use Poppler, e.g.:

```sh
pdftoppm -scale-to 1680 -png -singlefile target/native-rendering-results/patched/customer-growth-5.pdf /tmp/slurp-pdf-check
pdfimages -list target/native-rendering-results/patched/customer-growth-5.pdf
```

The initial comparative timing samples ran while release compilation was active. Treat those as exploratory, and rerun already-built hosts without compilation before comparing performance.

For a comparison run without compiler contention after all hosts have been built:

```sh
python3 spikes/native-rendering/benchmark.py
```

Use `summary.json` for aggregate samples and each `*-resources.txt` for process peak memory. Check the scope notes above before interpreting the numbers.

Version compatibility caveat: the pinned vl-convert release bundles Vega 6.4.0 and Vega-Lite 6.4.3 (default selector 6.4); Slurp currently embeds Vega 6.4.0 and Vega-Lite 6.5.0. Its results therefore assess compatibility with the same prepared input, not a compiler-version-controlled font-only comparison. It cannot be adopted as an exact replacement for the current Vega-Lite version without addressing that gap.

Historical note: RESULTS.md describes the pre-integration comparison. The harness imports production code, so after the DPR/font integration its baseline no longer reproduces the historical workaround. Preserve the archived results when comparing against that earlier implementation.
