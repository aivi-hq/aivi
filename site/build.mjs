// The site has two halves: a hand-written landing page and Markdown docs.
// This script copies the landing assets and renders each Markdown page into
// the shared documentation shell. Everything it writes lands in dist/, which
// is what the Pages workflow uploads.

import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Marked } from 'marked';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.join(here, 'src');
const output = path.join(here, 'dist');
const docsSource = path.join(source, 'docs');

const marked = new Marked({ gfm: true });

function parseFrontmatter(raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { data: {}, body: raw };

  const data = {};
  for (const line of match[1].split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const colon = trimmed.indexOf(':');
    if (colon === -1) continue;
    const key = trimmed.slice(0, colon).trim();
    let value = trimmed.slice(colon + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    data[key] = value;
  }

  return { data, body: raw.slice(match[0].length) };
}

function escapeHtml(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function finalize(html) {
  return html.replace(/^[ \t]+$/gm, '');
}

function slugify(value) {
  return value
    .replace(/<[^>]+>/g, '')
    .replaceAll('&amp;', 'and')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function addHeadingIds(html) {
  const toc = [];
  const seen = new Map();

  const withIds = html.replace(/<h([23])>([\s\S]*?)<\/h\1>/g, (_match, level, content) => {
    const explicit = content.match(/\s*\{#([a-z0-9-]+)\}\s*$/);
    const cleaned = explicit ? content.slice(0, explicit.index).trimEnd() : content;
    const base = explicit?.[1] ?? (slugify(cleaned) || 'section');
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    const id = count === 0 ? base : `${base}-${count}`;
    const text = cleaned.replace(/<[^>]+>/g, '').replaceAll('&amp;', '&');
    toc.push({ level: Number(level), id, text });
    return `<h${level} id="${id}">${cleaned}</h${level}>`;
  });

  return { html: withIds, toc };
}

function renderToc(items) {
  if (items.length === 0) return '';
  const links = items
    .map(entry => {
      const className = entry.level === 3 ? ' class="toc-sub"' : '';
      return `<li${className}><a href="#${entry.id}">${entry.text}</a></li>`;
    })
    .join('\n        ');
  return `<nav class="page-toc" aria-label="On this page">
      <p class="page-toc-title">On this page</p>
      <ul>
        ${links}
      </ul>
    </nav>`;
}

function renderNav(pages, activeSlug) {
  const link = page => {
    const active = page.slug === activeSlug ? ' class="active"' : '';
    const current = page.slug === activeSlug ? ' aria-current="page"' : '';
    return `<li><a${active}${current} href="${page.slug}.html">${escapeHtml(page.title)}</a></li>`;
  };

  const groups = groupPages(pages)
    .map(
      group => `<p class="docs-nav-group">${escapeHtml(group.name)}</p>
      <ol>
        ${group.pages.map(link).join('\n        ')}
      </ol>`,
    )
    .join('\n      ');

  return `<nav class="docs-nav" aria-label="Documentation">
      <p class="docs-nav-title">Documentation</p>
      <ol class="docs-nav-overview">
        <li><a${activeSlug === '' ? ' class="active" aria-current="page"' : ''} href="index.html">Overview</a></li>
      </ol>
      ${groups}
    </nav>`;
}

function groupPages(pages) {
  const groups = [];
  for (const page of pages) {
    let group = groups.find(entry => entry.name === page.group);
    if (!group) {
      group = { name: page.group, pages: [] };
      groups.push(group);
    }
    group.pages.push(page);
  }
  return groups;
}

function renderPrevNext(pages, index) {
  const previous = pages[index - 1];
  const next = pages[index + 1];
  if (!previous && !next) return '';

  const previousLink = previous
    ? `<a class="page-nav-link" href="${previous.slug}.html"><span>Previous</span>${escapeHtml(previous.title)}</a>`
    : '<span></span>';
  const nextLink = next
    ? `<a class="page-nav-link page-nav-next" href="${next.slug}.html"><span>Next</span>${escapeHtml(next.title)}</a>`
    : '';

  return `${previousLink}${nextLink}`;
}

function renderDocsIndex(pages) {
  const groups = groupPages(pages)
    .map(
      group => `<section class="docs-index-group">
      <h2>${escapeHtml(group.name)}</h2>
      <ol class="docs-index-list">
        ${group.pages
          .map(
            page => `<li>
          <a href="${page.slug}.html">
            <span class="index-title">${escapeHtml(page.title)}</span>
            <span class="index-description">${escapeHtml(page.description)}</span>
          </a>
        </li>`,
          )
          .join('\n        ')}
      </ol>
    </section>`,
    )
    .join('\n    ');

  return `<p>Start with the five minute tour. The rest is the manual you reach for when you need it, with the full installer, board, chat and operator details kept close.</p>
    ${groups}
    <div class="docs-index-note">
      <p>Looking for the full reference? The repository holds the detailed chapters on <a href="https://github.com/aivi-hq/aivi/blob/main/docs/operations.md">operations</a>, <a href="https://github.com/aivi-hq/aivi/blob/main/docs/configuration.md">configuration</a>, <a href="https://github.com/aivi-hq/aivi/blob/main/docs/architecture.md">architecture</a>, and every plugin.</p>
    </div>`;
}

async function readPages() {
  const files = (await readdir(docsSource)).filter(file => file.endsWith('.md')).sort();
  const pages = [];

  for (const file of files) {
    const slug = file.replace(/\.md$/, '');
    const raw = await readFile(path.join(docsSource, file), 'utf8');
    const { data, body } = parseFrontmatter(raw);
    if (!data.title) throw new Error(`${file} is missing a title in its frontmatter`);
    pages.push({
      slug,
      title: data.title,
      description: data.description ?? '',
      order: Number(data.order ?? 999),
      group: data.group ?? 'Documentation',
      body,
    });
  }

  return pages.sort((a, b) => a.order - b.order);
}

async function build() {
  await rm(output, { recursive: true, force: true });
  await mkdir(path.join(output, 'docs'), { recursive: true });

  const template = await readFile(path.join(source, 'docs-template.html'), 'utf8');
  const pages = await readPages();

  for (const [index, page] of pages.entries()) {
    const rendered = marked.parse(page.body);
    const { html, toc } = addHeadingIds(rendered);
    const editUrl = `https://github.com/aivi-hq/aivi/edit/main/site/src/docs/${page.slug}.md`;

    const document = template
      .replaceAll('{{title}}', escapeHtml(page.title))
      .replaceAll('{{description}}', escapeHtml(page.description))
      .replaceAll('{{nav}}', renderNav(pages, page.slug))
      .replaceAll('{{content}}', html)
      .replaceAll('{{toc}}', renderToc(toc))
      .replaceAll('{{prevnext}}', renderPrevNext(pages, index))
      .replaceAll('{{edit}}', editUrl)
      .replaceAll('{{editlabel}}', 'Edit this page on GitHub');

    await writeFile(path.join(output, 'docs', `${page.slug}.html`), finalize(document));
  }

  const indexDocument = template
    .replaceAll('{{title}}', 'Documentation')
    .replaceAll('{{description}}', 'Install aivi, connect a project, and keep the server running.')
    .replaceAll('{{nav}}', renderNav(pages, ''))
    .replaceAll('{{content}}', renderDocsIndex(pages))
    .replaceAll('{{toc}}', '')
    .replaceAll('{{prevnext}}', '')
    .replaceAll('{{edit}}', 'https://github.com/aivi-hq/aivi/tree/main/site/src/docs')
    .replaceAll('{{editlabel}}', 'Browse the documentation source on GitHub');

  await writeFile(path.join(output, 'docs', 'index.html'), finalize(indexDocument));

  for (const asset of ['index.html', 'styles.css', 'docs.css', 'site.js', 'aivi-mark.svg']) {
    await cp(path.join(source, asset), path.join(output, asset));
  }

  // GitHub Pages serves the artifact directly, but .nojekyll keeps that true
  // if the site is ever published from a branch instead.
  await writeFile(path.join(output, '.nojekyll'), '');

  console.log(`Built ${pages.length} documentation pages into ${path.relative(here, output)}/`);
}

await build();
