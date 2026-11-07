import {readFileSync,writeFileSync,mkdirSync,rmSync} from 'node:fs';
let html=readFileSync('dist/index.html','utf8');
html=html.replace(/<script type="module" crossorigin src="([^"]+)"><\/script>/g,(_,path)=>`<script type="module">${readFileSync('dist/'+path.replace(/^\.\//,''),'utf8').replace(/<\/script/gi,'<\\/script')}</script>`);
html=html.replace(/<link rel="stylesheet" crossorigin href="([^"]+)">/g,(_,path)=>`<style>${readFileSync('dist/'+path.replace(/^\.\//,''),'utf8')}</style>`);
html=html.replace('<title>',`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; base-uri 'none'"/><title>`);
writeFileSync('dist/index.html',html);mkdirSync('../../crates/slurp-cli/assets',{recursive:true});writeFileSync('../../crates/slurp-cli/assets/setup.html',html);rmSync('dist/assets',{recursive:true,force:true});
