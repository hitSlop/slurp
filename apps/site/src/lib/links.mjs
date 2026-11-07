// Where Slurp lives. Change a link here and the site, the Deploy button and the install commands follow.
export const siteUrl = 'https://slurp.run';
export const githubUrl = 'https://github.com/hitSlop/slurp';
export const defaultBranch = 'master';
// The Discord invite. Leave it empty until there is one: an empty link is not shown anywhere.
export const discordUrl = '';

// Installing the CLI (macOS and Linux). Both come from the GitHub Release for the latest v* tag.
export const installShell = `curl -LsSf ${githubUrl}/releases/latest/download/slurp-cli-installer.sh | sh`;
export const installNpm = 'npm install -g @hitslop/slurp';
