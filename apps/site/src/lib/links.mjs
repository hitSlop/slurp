// Where Slurp lives. Change a link here and the site, the Deploy button and the install commands follow.
export const siteUrl = 'https://slurp.run';
export const githubUrl = 'https://github.com/hitSlop/slurp';
export const defaultBranch = 'master';
// The Discord invite. An empty value hides every Discord link on the site.
export const discordUrl = 'https://discord.gg/jprRVWSRdn';

// Installing the CLI (macOS and Linux). slurp.run/install redirects to the installer on the latest GitHub Release.
export const installShell = `curl -LsSf ${siteUrl}/install | sh`;
export const installNpm = 'npm install -g @hitslop/slurp';
export const installSdk = 'npm install @hitslop/slurp-sdk';
