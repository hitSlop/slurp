import {build} from '../../report-assets/node_modules/esbuild/lib/main.js';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'../..');
const result=await build({stdin:{contents:`export {prepareChart} from './report-assets/src/lib/chart/prepare.ts'; export {vegaTheme} from './report-assets/src/lib/vegaTheme.ts'; export {paletteFor} from './report-assets/src/lib/themes/palette.ts';`,resolveDir:root},bundle:true,format:'esm',platform:'node',write:false});
const {prepareChart,vegaTheme,paletteFor}=await import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].text).toString('base64'));
const out=process.argv[2];mkdirSync(out,{recursive:true});
let variationCount=0;
for(const slug of ['customer-growth','enterprise-survey','chart-cases','utc-month']){
 const dir=root+'/crates/slurp-render/tests/fixtures/'+slug;
 const def=JSON.parse(readFileSync(dir+'/definition.json'));const run=JSON.parse(readFileSync(dir+'/run.json'));
 def.blocks.forEach((b,i)=>{if(b.kind==='chart')writeFileSync(`${out}/${slug}-${i}.json`,JSON.stringify(prepareChart(b.spec,run.queries[b.query],{theme:vegaTheme(paletteFor('light'),'Geist'),width:640,height:260})));});
}

let count=0;
for(const slug of ['customer-growth','enterprise-survey','chart-cases','utc-month']){
 const dir=root+'/crates/slurp-render/tests/fixtures/'+slug;const def=JSON.parse(readFileSync(dir+'/definition.json'));const run=JSON.parse(readFileSync(dir+'/run.json'));
 for(const [i,b] of def.blocks.entries()){if(b.kind!=='chart'||count++>=3)continue;
 for(const [suffix,width,font,theme] of [['dark-mono-250',250,'Geist Mono','dark'],['light-sans-382',382,'Geist','light']])writeFileSync(`${out}/${slug}-${i}--${suffix}.json`,JSON.stringify(prepareChart(b.spec,run.queries[b.query],{theme:vegaTheme(paletteFor(theme),font),width,height:260})));
 }
}

for (const [name,label] of [['font-probe-i','iiiiiiiiii'],['font-probe-w','WWWWWWWWWW']]) {
 const spec={mark:'bar',encoding:{y:{field:'label',type:'nominal',axis:{title:null}},x:{field:'value',type:'quantitative',axis:{title:null}}}};
 const data={columns:[{name:'label',type:'VARCHAR'},{name:'value',type:'DOUBLE'}],rows:[[label,10]]};
 writeFileSync(`${out}/${name}.json`,JSON.stringify(prepareChart(spec,data,{theme:vegaTheme(paletteFor('light'),'Geist'),width:200,height:100})));
}
