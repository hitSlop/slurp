# Vendored renderer correction

`takumi-core/` is the crates.io takumi-core 0.35.0 source, with only the four-file device-pixel-ratio backport in `slurp-dpr.patch`. Its normalized Cargo.toml is retained. The patch resolves SVG lengths in CSS pixels and applies device scaling once, including non-scaling strokes. It was tested against the native-rendering spike before integration.

Origin: https://github.com/kane50613/takumi (crates.io release 0.35.0). Licensing and third-party notices are included. No local reference checkout is required to build Slurp.

To verify the backport, apply `patch -p1 < slurp-dpr.patch` to pristine crates.io 0.35.0 source and compare the four files. Remove this patch override when an upstream release includes equivalent fixes and the SVG/real-chart regressions pass. Do not update this source independently of those tests.

Upstream crates.io archive SHA-256: `81026e2b18d8ce4035c95ef8d1d33665201091630e82587a40e778645be3b1d9`.
