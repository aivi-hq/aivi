export type { ForgeGithubConfig } from './config.ts';
export { forgeGithubSchema, plugin } from './config.ts';
export { createGitHubForge, GitHubForge } from './forge.ts';
export { createForgeGithubModule } from './module.ts';
export type { GitHubRemote } from './remote.ts';
export { GITHUB_HOST, httpsRemote, isGitHub, parseRemote } from './remote.ts';
export { suggestedProjectId } from './setup-project.ts';
