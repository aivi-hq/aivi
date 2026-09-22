/** The plugin `./setup` plumbing: prompts, writers and the verified last
 *  line, handed to whatever package aivi installs. */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PluginSetup, PluginSetupContext } from '@aivi/core';
import { errorMessage, PluginSetupCancelled, upsertEnvFile, writeConfigBlock } from '@aivi/core';
import * as p from '@clack/prompts';

/**
 * The plumbing step behind `aivi install`: run the plugin's own setup entry.
 * A package's `./setup` subpath is the whole contract — a package without one
 * has nothing to say at install time, and the command says so. Everything
 * platform-specific lives in the plugin; this only wires the context: clack
 * prompts, the config and .env writers with their write-validate-restore
 * guarantee, and the verified last line. A cancelled prompt stops the flow;
 * nothing after it is written.
 */
export async function pluginSetup(
  spec: string,
  options: { home: string; configPath: string; identityName: string },
): Promise<void> {
  let entry: unknown;
  try {
    entry = ((await import(import.meta.resolve(`${spec}/setup`))) as { default?: unknown }).default;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'ERR_PACKAGE_PATH_NOT_EXPORTED')
      throw new Error(
        `${spec} has no setup command (no ./setup export); its package says how to configure it by hand.`,
      );
    if (code === 'ERR_MODULE_NOT_FOUND')
      throw new Error(`${spec} is not installed in this installation. \`aivi install ${spec}\` installs it first.`);
    throw error;
  }
  if (typeof entry !== 'function') throw new Error(`${spec}/setup exports no function.`);
  if (!process.stdin.isTTY)
    throw new Error(
      `plugin setup needs an interactive terminal; to configure ${spec} without one, edit config.json and .env by hand (docs/getting-started.md).`,
    );
  p.intro(`aivi install — ${spec}`);
  const ctx: PluginSetupContext = {
    home: options.home,
    configPath: options.configPath,
    identityName: options.identityName,
    config: JSON.parse(await readFile(options.configPath, 'utf8')) as Record<string, unknown>,
    note: (title, lines) => p.note(lines, title),
    log: message => console.log(message),
    ask: {
      async text({ message, placeholder, secret, validate }) {
        const check = validate ? (value: string | undefined) => validate(value ?? '') : undefined;
        const answer = secret
          ? await p.password({ message, ...(check ? { validate: check } : {}) })
          : await p.text({ message, ...(placeholder ? { placeholder } : {}), ...(check ? { validate: check } : {}) });
        if (p.isCancel(answer)) throw new PluginSetupCancelled('a prompt was cancelled');
        return String(answer);
      },
      async confirm({ message, initial }) {
        const answer = await p.confirm({ message, initialValue: initial ?? false });
        if (p.isCancel(answer)) throw new PluginSetupCancelled('a prompt was cancelled');
        return answer;
      },
    },
    fetch: (url, init) => fetch(url, init),
    async writeConfigBlock(path, value) {
      await writeConfigBlock(options.configPath, path, value);
    },
    async writeSecret(key, value) {
      upsertEnvFile(join(options.home, '.env'), key, value);
    },
  };
  try {
    const result = await (entry as PluginSetup)(ctx);
    // The record on stdout is the machine-readable result; the outro is the human truth.
    console.log(JSON.stringify(result, null, 2));
    p.outro(result.summary);
  } catch (error) {
    if (error instanceof PluginSetupCancelled) p.cancel('Setup stopped. Nothing further was written.');
    else p.cancel(`Setup stopped: ${errorMessage(error)}. Nothing further was written.`);
    process.exitCode = 1;
  }
}
