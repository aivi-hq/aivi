/**
 * The install contract an installable plugin package fills. `aivi install`
 * npm-installs the package into the server home and then runs its `./setup`
 * entry; the CLI knows nothing platform-specific. Everything the flow needs
 * arrives through the context, so the flow prints its own platform
 * instructions and is testable without a terminal or a platform account.
 */

/** A prompt the person cancelled; the runner says it stopped and writes nothing further. */
export class PluginSetupCancelled extends Error {}

export interface PluginSetupContext {
  /** The aivi home that owns `config.json` and `.env`. */
  home: string;
  configPath: string;
  /** The persona from config.json `identity.name` — what the bot is called on the platform. */
  identityName: string;
  /** The raw parsed `config.json`, so a flow can see what is already configured. */
  config: Record<string, unknown>;
  /** Print the instructions the plugin owns: how to create the platform app, what to copy where. */
  note(title: string, lines: string): void;
  log(message: string): void;
  ask: {
    /** One line of text; `secret` asks it hidden. Throws PluginSetupCancelled on cancel. */
    text(options: {
      message: string;
      placeholder?: string | undefined;
      secret?: boolean | undefined;
      validate?: ((value: string) => string | undefined) | undefined;
    }): Promise<string>;
    /** Yes or no; throws PluginSetupCancelled on cancel. */
    confirm(options: { message: string; initial?: boolean | undefined }): Promise<boolean>;
  };
  /** Platform calls the flow verifies with; the runner supplies the real fetch. */
  fetch(url: string, init?: RequestInit): Promise<Response>;
  /** Write this plugin's block into `config.json`; the file must load again or the old bytes return. */
  writeConfigBlock(path: string[], value: unknown): Promise<void>;
  /** Replace-or-append one key in `<home>/.env`, kept 0600; the value is never echoed. */
  writeSecret(key: string, value: string): Promise<void>;
}

export interface PluginSetupResult {
  /** The module the flow enabled — the id `aivi install` watches in `/v1/status`. */
  module: string;
  /** The verified last line: what is true now, never what may happen. */
  summary: string;
}

/** Every plugin's `./setup` entry: one default-exported function. */
export type PluginSetup = (ctx: PluginSetupContext) => Promise<PluginSetupResult>;
