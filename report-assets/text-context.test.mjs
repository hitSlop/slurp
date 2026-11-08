import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {build} from 'esbuild';
import {nativeTextMetrics} from './native-text-plugin.mjs';
async function engine(){
  const calls=[];
  const {outputFiles}=await build({stdin:{contents:"export {textMetrics,parse,View} from 'vega';",resolveDir:process.cwd()},plugins:[nativeTextMetrics],bundle:true,format:'iife',globalName:'vega',write:false,banner:{js:readFileSync('src/lib/chart/polyfills.js','utf8')}});
  const ctx=vm.createContext({__slurpMeasureText(text,family,size,weight,style,variant){
    calls.push({text,family,size,weight,style,variant});
    return [...text].reduce((sum,c)=>sum+(c==='i'?0.25:c==='W'?1:0.5),0)*size*(weight==='700'?1.1:1);
  }});
  vm.runInContext(outputFiles[0].text,ctx);
  return {vega:ctx.vega,calls};
}
test('Vega measures native advances and retains its font-aware cache',async()=>{
  const {vega,calls}=await engine();const width=vega.textMetrics.width;
  assert.equal(width({fontSize:12},'iiii'),12);
  assert.equal(width({fontSize:12},'WWWW'),48);
  const count=calls.length;assert.equal(width({fontSize:12},'WWWW'),48);assert.equal(calls.length,count);
  assert.equal(width({fontSize:24},'WWWW'),96);
  assert.ok(width({fontSize:12,fontWeight:700},'WWWW')>48);
  width({font:'Geist Mono',fontSize:12,fontStyle:'italic',fontVariant:'small-caps'},'WWWW');
  assert.equal(calls.at(-1).family,'Geist Mono');assert.equal(calls.at(-1).style,'italic');assert.equal(calls.at(-1).variant,'small-caps');
});
test('Vega truncates both its bounds and emitted SVG text with native measurements',async()=>{
  for(const dir of ['ltr','rtl']){
    const {vega}=await engine();
    assert.ok(vega.textMetrics.width({fontSize:12,limit:40,dir},'WWWWWWWW')<=40);
    const view=new vega.View(vega.parse({width:200,height:100,marks:[{type:'text',encode:{enter:{text:{value:'WWWWWWWW'},font:{value:'Geist'},fontSize:{value:12},limit:{value:40},dir:{value:dir},x:{value:10},y:{value:20}}}}]}),{renderer:'none'});
    try {
      await view.runAsync();const svg=await view.toSVG();
      const labels=[...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map(match=>match[1]);
      assert.ok(labels.some(label=>label.includes('…')&&label.length<8),svg);
    } finally {view.finalize();}
  }
});
