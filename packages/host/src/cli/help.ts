/** The root's opening screen. Help itself is unstyled — command output owns the
 *  color budget, and the wordmark says enough. */

import { homedir } from 'node:os';
import { brandBanner } from '@aivi/core';

/** The wordmark, the version and one line of orientation, colored on a
 *  terminal, plain text under a pipe. A trailing blank line keeps Usage off
 *  the mark. */
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
