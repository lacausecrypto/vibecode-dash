import { marked } from 'marked';
import { Fragment, useMemo } from 'react';
import { AgentChartFromRaw } from './AgentChart';

marked.setOptions({ gfm: true, breaks: true });

/**
 * Matches a full `<chart …>…</chart>` block, non-greedy across lines.
 * Captured groups aren't used — we slice the whole match for further parsing
 * inside the AgentChart component.
 */
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

function renderMarkdown(text: string): string {
  if (!text.trim()) return '';
  try {
    return marked.parse(text, { async: false }) as string;
  } catch {
    return '';
  }
}

export function Markdown({
  content,
  className,
}: {
  content: string;
  className?: string;
}) {
  const segments = useMemo(() => splitSegments(content || ''), [content]);

  if (segments.length === 0) {
    return null;
  }

  // Fast path: no chart blocks, single markdown render.
  if (segments.length === 1 && segments[0].kind === 'md') {
    const html = renderMarkdown(segments[0].text);
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
        // segments are derived deterministically from `content`; using the
        // index plus a content discriminator keeps keys stable across renders
        // as long as the content doesn't change.
        const key =
          seg.kind === 'chart' ? `c-${index}-${seg.raw.length}` : `m-${index}-${seg.text.length}`;
        if (seg.kind === 'chart') {
          return <AgentChartFromRaw key={key} raw={seg.raw} />;
        }
        const html = renderMarkdown(seg.text);
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
