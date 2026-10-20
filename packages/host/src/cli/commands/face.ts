/** The face: the picture aivi wears whenever aivi needs a camera (Meet
 *  today, other rooms later). The built-in lives in `@aivi/core`; the
 *  home's `face/index.html` copy is the operator's own face, read at use:
 *  an edit lands on the next join, and deleting the file is instant
 *  restoration — the same deal as prompts. This command is the sight and
 *  the copy-step. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { installFace, readFaceHtml, stripPromptHeader } from '@aivi/core';
import type { Command } from 'commander';
import { home, print } from '../context.ts';

const facePath = () => join(home(), 'face', 'index.html');

/** Where the face comes from right now: the home's file when it holds one,
 *  the built-in otherwise — the same reading `readFaceHtml` gives. */
function faceSource(): 'file' | 'built-in' {
  try {
    return stripPromptHeader(readFileSync(facePath(), 'utf8')) ? 'file' : 'built-in';
  } catch {
    return 'built-in';
  }
}

export function registerFace(program: Command): void {
  const face = program
    .command('face')
    .description('The face aivi shows on camera: where it lives, install the editable copy, show the source')
    .helpGroup('Server')
    .action(async () => {
      print(
        { path: facePath(), source: faceSource(), preview: 'npx serve in its directory' },
        `The face lives at ${facePath()}. Install an editable copy with \`aivi face install\`; delete it to get the built-in back.`,
      );
    });
  face
    .command('install')
    .description(
      "Copy the built-in face into the home for editing; a file that is already there is nobody's to overwrite",
    )
    .action(async () => {
      const { written, kept } = await installFace(home());
      print({ written, kept }, [
        {
          type: 'log',
          text: written ? `Installed: ${facePath()}.` : 'Nothing to install: the copy is already in the home.',
        },
        {
          type: 'log',
          text: `Edit it freely — every camera aivi shows wears it from the next join. \`npx serve ${join(home(), 'face')}\` previews it. Delete the file to get the built-in back.`,
        },
      ]);
    });
  face
    .command('show')
    .description("The face aivi wears today: the home's file when it holds one, the built-in otherwise")
    .action(async () => {
      const text = await readFaceHtml(home());
      print({ path: facePath(), source: faceSource(), text }, text);
    });
}
