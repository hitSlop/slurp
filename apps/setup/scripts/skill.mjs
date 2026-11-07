import {readFileSync,writeFileSync} from 'node:fs';
const path='../../crates/slurp-cli/skills/slurp/SKILL.md', snippets=JSON.parse(readFileSync('../../docs/onboarding/snippets.json','utf8'));
let text=readFileSync(path,'utf8').split('\n<!-- onboarding:generated -->')[0];
text+='\n<!-- onboarding:generated -->\n\n## Instrument and connect\n\nInstall the SDK with npm install @hitslop/slurp-sdk. Replace placeholders with source setup values. Producers use publishable keys; remote bots use separately named secret read keys. Keep credentials in secret stores, never in skills or Git. The personalized setup HTML is private.\n';
for(const [name,code] of Object.entries(snippets))text+=`\n### ${name}\n\n\`\`\`${name==='sdk'?'js':'sh'}\n${code}\n\`\`\`\n`;
writeFileSync(path,text);
