import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, cpSync, symlinkSync, appendFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

test('check detects stale source even when embedded bundle and metadata agree',()=>{
  const root=mkdtempSync(join(tmpdir(),'slurp-bundle-check-'));
  try {
    const report=join(root,'report-assets');mkdirSync(report);
    cpSync('src',join(report,'src'),{recursive:true});
    for(const file of ['build.mjs','native-text-plugin.mjs','package.json'])copyFileSync(file,join(report,file));
    symlinkSync(resolve('node_modules'),join(report,'node_modules'),'dir');
    const assets=join(root,'crates/slurp-render/assets');mkdirSync(assets,{recursive:true});
    for(const file of ['render.js.zst','versions.json','themes.json'])copyFileSync('../crates/slurp-render/assets/'+file,join(assets,file));
    const before=readFileSync(join(assets,'render.js.zst'));
    const run=()=>spawnSync(process.execPath,['build.mjs','--check'],{cwd:report,encoding:'utf8'});
    const fresh=run();assert.equal(fresh.status,0,fresh.stderr);
    appendFileSync(join(report,'src/lib/chart/render-entry.ts'),'\nglobalThis.__staleBundleProbe = 1;\n');
    const stale=run();assert.notEqual(stale.status,0);assert.match(stale.stderr,/Embedded chart assets are stale/);
    assert.deepEqual(readFileSync(join(assets,'render.js.zst')),before,'check must not rewrite embedded artifacts');
  } finally {rmSync(root,{recursive:true,force:true});}
});
