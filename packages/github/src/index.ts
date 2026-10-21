/** The GitHub app aivi works as, as one plain library (ruled 2026-10-07):
 *  the forge and the tracker are **one app**, so the credential, the one
 *  installation, the API client, the git transport, the webhook seal, and the
 *  worker signature live here and nowhere else.
 *
 *  What deliberately is not here: lanes, board items, Status, the `Agent`
 *  field, remotes, and pull-request facts — those belong to whichever plugin
 *  speaks them. This package registers nothing and owns no config block; the
 *  app's identity is `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` in
 *  `<home>/.env`, read by `githubCredentials`.
 */
export {
  GIT_USER,
  GITHUB_APP_ID_ENV,
  GITHUB_PRIVATE_KEY_ENV,
  GitHubApp,
  type GitHubCredentials,
  type GitHubGrant,
  type GitHubOptions,
  type GitHubWebhookConfig,
  type GitHubWebhookDelivery,
  type GitRunner,
  gitCredential,
  githubApp,
  githubCredentials,
  githubPrivateKey,
  type Octokit,
  pemForEnvFile,
  resolveKeyPath,
  runGit,
} from './github.ts';
export { appIdentity, type GitHubIdentityGuide } from './identity.ts';
export { parseWorker, signComment } from './signature.ts';
export {
  GITHUB_WEBHOOK_SECRET_ENV,
  verifyWebhookSignature,
  WEBHOOK_SIGNATURE_HEADER,
  webhookSignature,
} from './webhook.ts';
