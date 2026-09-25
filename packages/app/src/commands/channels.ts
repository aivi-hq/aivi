/** Channel commands live in their packages: each enabled module's package is
 *  asked for its `./cli` subpath (@aivi/host `PluginCliCommand`), and whatever
 *  answers is mounted into the tree — the app owns parsing and help, the
 *  package owns the words and the work. The mapping is the same bounded,
 *  config-driven one the host uses; nothing scans node_modules. A package that
 *  is not installed is simply absent from the help, like a module that is not
 *  configured. */

import type { LoadedConfig } from '@aivi/core';
import { errorMessage } from '@aivi/core';
import type { PluginCliCommand, PluginCliContext, PluginCliSubcommand, Store } from '@aivi/host';
import * as p from '@clack/prompts';
import type { Command } from 'commander';
import { configPath, context, home, print, withStore } from '../context.ts';

/** The module id → package spec mapping, the one the host and the installer keep too. */
const MODULE_SPECS: Record<string, string> = {
  discord: '@aivi/channel-discord',
  slack: '@aivi/channel-slack',
  linear: '@aivi/linear',
};

/** The shape the contract asks for; anything else means "nothing to mount". */
function isPluginCliCommand(value: unknown): value is PluginCliCommand {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as PluginCliCommand).name === 'string' &&
    Array.isArray((value as PluginCliCommand).subcommands) &&
    (value as PluginCliCommand).subcommands.every(sub => typeof sub.name === 'string' && typeof sub.run === 'function')
  );
}

/** The capabilities the app lends a plugin's commands: its own context and
 *  store bracket, the shared streams, the host poke, and one prompt. */
function pluginCliContext(): PluginCliContext {
  return {
    home,
    configPath,
    loaded: async (): Promise<LoadedConfig> => (await context()).loaded,
    withStore: async <T>(fn: (store: Store) => T | Promise<T>) => withStore((await context()).loaded, fn),
    print,
    log: message => console.error(message),
    poke: async () => {
      await (await context()).poke();
    },
    ask: {
      async text({ message, placeholder, validate }) {
        // Clack hands the prompt what was typed, maybe nothing; the contract's
        // validator wants a string, so empty becomes ''.
        const check = validate ? (value: string | undefined) => validate(value ?? '') : undefined;
        const answer = await p.text({
          message,
          ...(placeholder ? { placeholder } : {}),
          ...(check ? { validate: check } : {}),
        });
        if (p.isCancel(answer)) return undefined;
        return String(answer).trim();
      },
    },
  };
}

const collect = (value: string, previous: string[]): string[] => [...previous, value];

/** The three shapes commander's overloads distinguish: a repeat collector
 *  (which wants its initial list), a valued default, and a bare option. */
function declareOption(subcommand: Command, option: NonNullable<PluginCliSubcommand['options']>[number]): void {
  const describe = [option.description, option.required ? '(required)' : ''].join(' ').trim();
  if (option.multiple) {
    if (option.required) subcommand.requiredOption(option.flags, describe, collect, []);
    else subcommand.option(option.flags, describe, collect, []);
  } else if (option.required) subcommand.requiredOption(option.flags, describe);
  else if (option.default !== undefined) subcommand.option(option.flags, describe, option.default);
  else subcommand.option(option.flags, describe);
}

/** A subcommand's action: relay the operands and option values into its `run`. */
function relay(subcommand: Command, sub: PluginCliSubcommand): void {
  subcommand.action(async (...rest) => {
    const values = rest[rest.length - 2] as Record<string, unknown>;
    const operands = rest.slice(0, -2) as string[];
    await sub.run(pluginCliContext(), operands, values);
  });
}

/** Mount one plugin command: the data becomes a commander subtree whose
 *  actions relay into the subcommand's `run` with the shared context. */
function mount(program: Command, command: PluginCliCommand): void {
  const cmd = program
    .command(command.name)
    .description(command.description)
    .helpGroup(command.helpGroup ?? 'Channels');
  for (const sub of command.subcommands) {
    const subcommand = cmd.command(`${sub.name}${sub.args ? ` ${sub.args}` : ''}`).description(sub.description);
    for (const option of sub.options ?? []) declareOption(subcommand, option);
    relay(subcommand, sub);
  }
}

/** Ask every mapped package for its command; the ones that answer join the tree. */
export async function registerChannels(program: Command): Promise<void> {
  for (const [, spec] of Object.entries(MODULE_SPECS)) {
    let exported: unknown;
    try {
      exported = ((await import(`${spec}/cli`)) as { default?: unknown }).default;
    } catch (error) {
      const code = (error as { code?: string }).code;
      // Not installed, or installed without a ./cli export: no commands to mount.
      if (code === 'ERR_MODULE_NOT_FOUND' || code === 'ERR_PACKAGE_PATH_NOT_EXPORTED') continue;
      console.error(`aivi: ${spec}/cli did not load (${errorMessage(error)}); its commands are absent.`);
      continue;
    }
    // The package is the whole boundary: its data is mounted as it stands, and
    // only the name collision with a built-in would be refused, which none has.
    if (isPluginCliCommand(exported)) mount(program, exported);
    else console.error(`aivi: ${spec}/cli exports no command; its commands are absent.`);
  }
}
