import {githubUrl, defaultBranch} from './links.mjs';
// Public GitHub (or GitLab) URL of this repository. Cloudflare's "Deploy to Cloudflare" button only works for public
// repositories; set this to '' to link to the terminal deployment instructions instead.
export const deployRepoUrl = githubUrl;
// Directory in the repository that holds the Worker. It must build on its own (it has its own package.json).
export const deployPath = 'backend';
export const deployButtonUrl = () => deployRepoUrl
  ? `https://deploy.workers.cloudflare.com/?url=${encodeURIComponent(`${deployRepoUrl.replace(/\/$/, '')}/tree/${defaultBranch}/${deployPath}`)}`
  : '';
