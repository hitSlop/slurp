import { build } from 'esbuild';
import { readFileSync,writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const result = await build({entryPoints:['src/lib/chart/render-entry.ts'],bundle:true,format:'iife',platform:'browser',target:'es2020',minify:true,write:false,banner:{js:readFileSync('src/lib/chart/polyfills.js','utf8')}});
const bytes=result.outputFiles[0].contents;
writeFileSync('../crates/slurp-render/assets/render.js.zst',execFileSync('zstd',['-19','--stdout','--no-progress'],{input:bytes}));
writeFileSync('../crates/slurp-render/assets/versions.json',JSON.stringify({vega:'6.4.0',vega_lite:'6.5.0',vega_interpreter:'2.3.2',bundle_sha256:createHash('sha256').update(bytes).digest('hex')},null,2)+'\n');

// Palettes for the Rust side (page CSS uses the same colors as the charts): every Perspective theme plus Slurp's own.
const palettes=await build({entryPoints:['src/lib/themes/palette.ts'],bundle:true,format:'esm',platform:'node',write:false,loader:{'.json':'json'}});
const mod=await import('data:text/javascript;base64,'+Buffer.from(palettes.outputFiles[0].text).toString('base64'));
writeFileSync('../crates/slurp-render/assets/themes.json',JSON.stringify(mod.themes.map(({gradient,...t})=>t),null,1)+'\n');
