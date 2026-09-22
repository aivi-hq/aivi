/** The help theme: the brand palette applied to commander's style hooks, and
 *  the wordmark banner over the root help. Commander calls the style methods
 *  for every string it renders and strips color itself when the output stream
 *  does not want it, so the methods here can style unconditionally; styleText
 *  keys off the same stdout the commander detection does. */

import { homedir } from 'node:os';
import { BRAND, brandBanner, brandStyle } from '@aivi/core';
import type { Command } from 'commander';

/** Style methods applied to every command's help. Terms (command, option and
 *  argument names) take the aivi green; titles (Commands:, Options:) the bold
 *  muted gray; descriptions stay the terminal's own foreground. */
const THEME = {
  styleTitle: (title: string) => brandStyle(['bold', BRAND.muted], title),
  styleCommandText: (text: string) => brandStyle(BRAND.primary, text),
  styleSubcommandText: (text: string) => brandStyle(BRAND.primary, text),
  styleOptionText: (text: string) => brandStyle(BRAND.primary, text),
  styleArgumentText: (text: string) => brandStyle(BRAND.primary, text),
};

/** Commander does not inherit help configuration down the tree; after the
 *  whole tree is built (module commands included), walk it once. */
export function applyThemedHelp(command: Command): void {
  command.configureHelp(THEME);
  for (const child of command.commands) applyThemedHelp(child);
}

/** The root's opening screen: the wordmark, the version and one line of
 *  orientation, colored on a terminal, plain text under a pipe. A trailing
 *  blank line keeps Usage off the mark. */
export function rootBanner(version: string, home: string, stream: NodeJS.WritableStream): string {
  const underHome = home.startsWith(homedir()) ? `~${home.slice(homedir().length)}` : home;
  return `${brandBanner(
    [
      { text: `aivi v${version} — the always-on teammate around OpenCode` },
      { text: `Home ${underHome} · \`aivi <command> --help\` for one command`, muted: true },
    ],
    stream,
  )}\n`;
}
