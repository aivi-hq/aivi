# aivi website

The public site is a static build. The landing page is hand-written HTML. The documentation pages are Markdown, rendered by a small Node script with no framework.

## See it locally

From this directory:

```sh
npm install
npm run dev
```

Open <http://127.0.0.1:4173/>. `npm run dev` rebuilds the site and starts a local server. Stop it with Ctrl+C and run the same command after editing a page.

To build without serving:

```sh
npm run build
```

The output lands in `dist/`. That directory is generated and ignored by git.

## Edit the site

| Path | Contents |
| --- | --- |
| `src/index.html` | The landing page, with the board, meeting and schedule demos. |
| `src/site.js` | The landing page demos. No framework. |
| `src/styles.css` | The shared styles, including the landing page. |
| `src/docs.css` | The documentation layout and prose styles. |
| `src/docs-template.html` | The shell around every documentation page. |
| `src/docs/*.md` | The documentation pages. |
| `src/aivi-mark.svg` | The aivi face mark, used in the header, hero and footer. |
| `archive/landing-v1/` | A static snapshot of the first landing page, kept for reference. It is not built or deployed. |

The brand colors are CSS variables at the top of `styles.css`. The site follows the banner: a deep navy ground, the blue to violet face, white type and a small green live state. Change the variables there to shift the palette without touching the components.

Each documentation page starts with frontmatter:

```yaml
---
title: Getting started
description: Install aivi, create a server, and check that it answers.
order: 1
---

The page content starts here.
```

`order` controls the sidebar and the previous/next links. The file name becomes the URL, so `src/docs/getting-started.md` becomes `docs/getting-started.html`.

Links between pages are relative and use the built name: `[Chat and knowledge](chat-knowledge.html)`. A heading can claim an explicit id with `{#team}`, which is how the landing page links to `docs/ways.html#team`.

## Deploy

`.github/workflows/pages.yml` builds the site and deploys `dist/` to GitHub Pages on every push to `main` that touches `site/`. In the repository settings, set **Pages → Source** to **GitHub Actions**.

The workflow runs `npm ci --prefix site`, so `package-lock.json` belongs in version control.

## Copy rules

The site follows the project's writing rules:

- No em dashes or en dashes.
- No exclamation marks.
- No staccato fragment runs.
- No "it is not X, it is Y" constructions.
- No claims that the code does not support.

Prefer a concrete noun and a date over a superlative.
