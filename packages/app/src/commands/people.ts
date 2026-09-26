/** Persons and their tokens, over HTTP to the running host. */

import type { LoadedConfig } from '@aivi/core';
import { printedBaseUrl } from '@aivi/core';
import { createHostClient } from '@aivi/host';
import * as p from '@clack/prompts';
import type { Command } from 'commander';
import { context, hostUrl, print } from '../context.ts';
import { readClientConfigToken } from '../identity.ts';

/** The paste-able connect line: composed from `host.public` when set, else a
 *  named caveat on the listen address. Both token mints end with it. */
function connectNote(loaded: LoadedConfig): string {
  const printed = printedBaseUrl(loaded.config);
  const how = '`npm install -g @aivi/cli`, run `aivi setup`, choose "Connect to a host", and paste both.';
  const url = printed.declared
    ? `url: ${printed.url}`
    : `url: ${printed.url} (host.public is unset, so that is the listen address)`;
  return `Shown once. Take these to them — ${url} and this token. There: ${how}`;
}

export function registerPeople(program: Command): void {
  const people = program.command('people').description('persons and their tokens').helpGroup('People');
  // Managing people is an operator act; the bearer comes from the client config.
  const peopleClient = async () =>
    createHostClient(hostUrl((await context()).loaded), { token: readClientConfigToken() });
  people
    .command('create <name>')
    .description('A person for records to belong to')
    .option('--email <email>', 'an email address to remember')
    .option('--role <role>', 'add an operator role')
    .action(async (name, values) => {
      const client = await peopleClient();
      const created = await client.createPerson({
        name,
        ...(values.email ? { email: values.email } : {}),
        ...(values.role ? { roles: [values.role] } : {}),
      });
      print(created);
      // Nine people in ten are created so they can receive a token; asking
      // here means nobody has to know `people token` exists.
      if (process.stdin.isTTY) {
        const mint = await p.confirm({ message: `Mint a token for ${created.name} now?`, initialValue: true });
        if (!p.isCancel(mint) && mint) {
          const minted = await client.createPersonToken(created.id, 'cli');
          print({
            person: created.id,
            label: minted.token.label,
            token: minted.secret,
            next: connectNote((await context()).loaded),
          });
        }
      }
    });
  people
    .command('list')
    .description('People and their ids')
    .action(async () => {
      print(await (await peopleClient()).people());
    });
  people
    .command('token <person>')
    .description('Mint a bearer for that person; shown once')
    .option('--label <label>', 'a label for the token', 'cli')
    .action(async (person, values) => {
      const minted = await (await peopleClient()).createPersonToken(person, values.label);
      print({
        person,
        label: minted.token.label,
        token: minted.secret,
        next: connectNote((await context()).loaded),
      });
    });
}
