import { marked } from 'marked';
import { Fragment, useEffect, useMemo, useState } from 'react';
import { getApiAuthHeader } from '../lib/api';
import { AgentChartFromRaw } from './AgentChart';

marked.setOptions({ gfm: true });

const CHART_BLOCK_REGEX = /<chart\b[^>]*>[\s\S]*?<\/chart>/gi;

type Segment = { kind: 'md'; text: string } | { kind: 'chart'; raw: string };

function splitSegments(content: string): Segment[] {
  const segments: Segment[] = [];
  let cursor = 0;
  for (const match of content.matchAll(CHART_BLOCK_REGEX)) {
    const start = match.index ?? 0;
    if (start > cursor) {
      segments.push({ kind: 'md', text: content.slice(cursor, start) });
    }
    segments.push({ kind: 'chart', raw: match[0] });
    cursor = start + match[0].length;
  }
  if (cursor < content.length) {
    segments.push({ kind: 'md', text: content.slice(cursor) });
  }
  if (segments.length === 0 && content.length > 0) {
    segments.push({ kind: 'md', text: content });
  }
  return segments;
}

// Accepts scheme-bearing URLs (http/https/data/mailto/#) and leaves them
// alone. Everything else is treated as a repo-relative path that must be
// rewritten to hit our asset endpoint. We accept `./foo.gif`, `foo.gif`,
// `docs/screenshot.png`, and even `/docs/demo.gif` — for the leading slash
// case we strip it because README conventions treat `/` as repo-root, not
// host-root.
function isAbsoluteUrl(src: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/|#|mailto:|data:)/i.test(src);
}

function normalizeRepoRelative(src: string): string {
  // Strip leading `/` (README authors use it to mean "repo root") and
  // `./` prefixes so the server can resolve against the README's dirname.
  let out = src.replace(/^\.\//, '');
  if (out.startsWith('/')) out = out.slice(1);
  return out;
}

// Slugifies a heading text into an anchor id (GitHub-style). Not
// collision-safe across a long doc but good enough for hash navigation.
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 80);
}

// Post-process the marked-rendered HTML:
//  1. Rewrite relative image/video src to our asset endpoint so GIFs load.
//  2. Append the auth token as ?token=… because <img>/<video> can't send
//     custom headers. The server middleware accepts token via query for GET
//     requests only. Without this, every image request would 403.
//  3. Add `loading="lazy"` to images — README galleries can be heavy.
//  4. Add `id` anchors on h1-h3 so in-doc links (`#section`) actually jump.
//  5. Wrap tables in a scrollable div so wide tables don't blow the layout.
//
// We parse with DOMParser rather than regex-stripping: regex on HTML is a
// fool's errand (quoted attributes, nested tags, HTML entities). DOMParser
// is part of the browser runtime, no extra bundle cost.
function postProcess(html: string, projectId: string | null, apiToken: string | null): string {
  if (typeof window === 'undefined' || !window.DOMParser) return html;

  const doc = new window.DOMParser().parseFromString(html, 'text/html');

  if (projectId) {
    const rewriteSrc = (el: HTMLElement, attr: 'src' | 'href'): void => {
      const raw = el.getAttribute(attr);
      if (!raw || isAbsoluteUrl(raw)) return;
      const rel = normalizeRepoRelative(raw);
      const tokenParam = apiToken ? `&token=${encodeURIComponent(apiToken)}` : '';
      el.setAttribute(
        attr,
        `/api/projects/${encodeURIComponent(projectId)}/asset?path=${encodeURIComponent(rel)}${tokenParam}`,
      );
    };

    for (const img of Array.from(doc.querySelectorAll('img'))) {
      rewriteSrc(img as HTMLElement, 'src');
      if (!img.hasAttribute('loading')) img.setAttribute('loading', 'lazy');
      // Decoupling from natural size keeps huge screenshots from pushing
      // the layout wider than the tab content. CSS handles the cap.
      img.setAttribute('decoding', 'async');
    }
    for (const video of Array.from(doc.querySelectorAll('video'))) {
      rewriteSrc(video as HTMLElement, 'src');
      for (const src of Array.from(video.querySelectorAll('source'))) {
        rewriteSrc(src as HTMLElement, 'src');
      }
    }
  }

  // Heading anchors — GitHub-style. Skip if author already set an id.
  for (const tag of ['h1', 'h2', 'h3', 'h4']) {
    for (const h of Array.from(doc.querySelectorAll(tag))) {
      if (!h.id) {
        const id = slugify(h.textContent || '');
        if (id) h.id = id;
      }
    }
  }

  // Wrap <table> in a scrollable container. Tables with 8+ columns in a
  // 600px tab will otherwise either overflow the page or squish to
  // unreadability.
  for (const table of Array.from(doc.querySelectorAll('table'))) {
    const wrap = doc.createElement('div');
    wrap.className = 'prose-table-wrap';
    table.parentNode?.insertBefore(wrap, table);
    wrap.appendChild(table);
  }

  // Open external links in a new tab + noopener. Internal anchors (`#foo`)
  // and our own asset URLs stay same-tab.
  for (const a of Array.from(doc.querySelectorAll('a[href]'))) {
    const href = a.getAttribute('href') || '';
    if (/^https?:\/\//i.test(href)) {
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
    }
  }

  return doc.body.innerHTML;
}

function renderMarkdown(
  text: string,
  projectId: string | null,
  apiToken: string | null,
  breaks: boolean,
): string {
  if (!text.trim()) return '';
  try {
    // `breaks` per-call: agent output authors messages with literal newlines
    // that should render as <br>; READMEs follow standard GFM where a single
    // newline collapses to a space (critical for shield badges stacked on
    // adjacent lines to flow inline instead of one per row).
    const html = marked.parse(text, { async: false, breaks }) as string;
    return postProcess(html, projectId, apiToken);
  } catch {
    return '';
  }
}

// Cache the token for the lifetime of the tab. We look it up once (lazy)
// then every Markdown instance reuses it. Mirroring the single-flight
// logic of api.ts without reaching into its internals.
let cachedToken: string | null = null;
let tokenFetchPromise: Promise<string | null> | null = null;

function loadApiToken(): Promise<string | null> {
  if (cachedToken) return Promise.resolve(cachedToken);
  if (tokenFetchPromise) return tokenFetchPromise;
  tokenFetchPromise = getApiAuthHeader()
    .then((hdrs) => {
      const t = hdrs['x-dashboard-token'] || null;
      cachedToken = t;
      return t;
    })
    .catch(() => null);
  return tokenFetchPromise;
}

export function Markdown({
  content,
  className,
  projectId = null,
  breaks = false,
}: {
  content: string;
  className?: string;
  // When set, relative image/video paths in the markdown are rewritten to
  // `/api/projects/:id/asset?path=...` so GIFs and screenshots actually
  // resolve. Pass null/undefined for agent outputs where paths are literal.
  projectId?: string | null;
  // GFM `breaks` option: true inserts <br> on single newlines. Use it for
  // agent/chat output where line breaks are intentional, but leave it off
  // for READMEs where authors rely on standard GFM (adjacent `![badge]`
  // lines should flow inline, not stack).
  breaks?: boolean;
}) {
  const [apiToken, setApiToken] = useState<string | null>(cachedToken);
  const segments = useMemo(() => splitSegments(content || ''), [content]);

  // Only bother fetching the token when we actually have relative paths to
  // rewrite (i.e. projectId was passed). Agent outputs render as-is.
  useEffect(() => {
    if (!projectId || cachedToken) return;
    let cancelled = false;
    void loadApiToken().then((t) => {
      if (!cancelled && t) setApiToken(t);
    });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  if (segments.length === 0) {
    return null;
  }

  if (segments.length === 1 && segments[0].kind === 'md') {
    const html = renderMarkdown(segments[0].text, projectId, apiToken, breaks);
    if (!html) {
      return (
        <pre
          className={`whitespace-pre-wrap text-[13px] leading-relaxed text-[var(--text)] ${className || ''}`.trim()}
        >
          {segments[0].text}
        </pre>
      );
    }
    return (
      <article
        className={`prose-readme text-[13.5px] leading-relaxed text-[var(--text)] ${className || ''}`.trim()}
        // biome-ignore lint/security/noDangerouslySetInnerHtml: trusted local agent output
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  }

  return (
    <div className={`flex flex-col gap-1 ${className || ''}`.trim()}>
      {segments.map((seg, index) => {
        const key =
          seg.kind === 'chart' ? `c-${index}-${seg.raw.length}` : `m-${index}-${seg.text.length}`;
        if (seg.kind === 'chart') {
          return <AgentChartFromRaw key={key} raw={seg.raw} />;
        }
        const html = renderMarkdown(seg.text, projectId, apiToken, breaks);
        if (!html) {
          if (!seg.text.trim()) return null;
          return (
            <pre
              key={key}
              className="whitespace-pre-wrap text-[13px] leading-relaxed text-[var(--text)]"
            >
              {seg.text}
            </pre>
          );
        }
        return (
          <Fragment key={key}>
            <article
              className="prose-readme text-[13.5px] leading-relaxed text-[var(--text)]"
              // biome-ignore lint/security/noDangerouslySetInnerHtml: trusted local agent output
              dangerouslySetInnerHTML={{ __html: html }}
            />
          </Fragment>
        );
      })}
    </div>
  );
}
