The 16 palettes in `perspective.json` are extracted from the checked-in Perspective
reference (`rust/perspective-viewer/src/themes/`). They retain the upstream names,
backgrounds, text colors, chart palettes, gradients and color roles. Theme files
inherit Pro Light's defaults, as Perspective's combined theme stylesheet does.

Regenerate with `node apps/desktop/scripts/extract-perspective-themes.mjs [themes-dir]`.
The application maps these roles onto shared CSS tokens in `index.ts`. Small text
and controls receive contrast adjustments, while the extracted source values stay
unchanged. Slurp's wordmark, layout and interaction code remain its own.

Perspective theme source: Copyright (c) 2017, the Perspective Authors; Apache-2.0.
See [the retained license](vendor/PERSPECTIVE-LICENSE.md). No Perspective runtime,
engine, web component or map/tile request is required by these palettes.

Slurp also supplies **Pitch Black**, a separate custom theme with a pure #000000
workspace, gray rules and a restrained yellow interface accent. It is defined in
`index.ts`; it is not counted among the sixteen upstream palettes.
