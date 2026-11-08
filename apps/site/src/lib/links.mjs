// Where Slurp lives. Change a link here and the site, the Deploy button and the install commands follow.
export const siteUrl = 'https://slurp.run';
export const githubUrl = 'https://github.com/hitSlop/slurp';
export const defaultBranch = 'master';
// The Discord invite. An empty value hides every Discord link on the site.
export const discordUrl = 'https://discord.gg/jprRVWSRdn';

// This site measures itself with Slurp (the dogfood project, docs/dogfood.md): page views, the feedback widget, and clicks on the Deploy
// button and the install commands. The key is publishable, so it can only add events. An empty key turns all of it off.
export const slurpEndpoint = 'https://events.slurp.run/v1/events';
export const slurpKey = 'slurp_pk_7b036bd1d908a66d_25b8b8f8cf11bf3153261ef21bc5a6dc9fa2bdab9aaac976';

// Installing the CLI (macOS and Linux). slurp.run/install redirects to the installer on the latest GitHub Release.
export const installShell = `curl -LsSf ${siteUrl}/install | sh`;
export const installNpm = 'npm install -g @hitslop/slurp';
export const installSdk = 'npm install @hitslop/slurp-sdk';
