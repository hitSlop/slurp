import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {deployButtonUrl} from '../src/lib/config.mjs';
import {githubUrl,defaultBranch} from '../src/lib/links.mjs';

test('README and site deploy the same isolated Worker directory on the published branch',()=>{
 const target=new URL(deployButtonUrl());
 assert.equal(target.origin,'https://deploy.workers.cloudflare.com');
 assert.equal(target.searchParams.get('url'),`${githubUrl}/tree/${defaultBranch}/backend`);
 const readme=readFileSync(new URL('../../../README.md',import.meta.url),'utf8');
 assert.ok(readme.includes(`[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](${target.href})`));
});
