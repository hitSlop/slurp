import { defineConfig } from 'astro/config';
import { siteUrl } from './src/lib/links.mjs';
export default defineConfig({site: siteUrl, output: 'static'});
