/**
 * Reddit deep-link helpers — the auth-free posting path.
 *
 * Reddit's Responsible Builder Policy (Nov 2025) requires manual approval
 * for every new OAuth app, and personal-use scripts are rarely greenlit.
 * Rather than fight the approval pipeline or risk browser-automation
 * detection, we build URLs that pre-fill Reddit's own web composer:
 *
 *   https://www.reddit.com/r/{sub}/submit?title=...&text=...&selftext=true
 *   https://www.reddit.com/r/{sub}/comments/{post_id}/   (+ clipboard body)
 *
 * The user clicks the link, Reddit's UI opens with title + body already
 * filled, the user clicks "Post". Friction = 2 seconds; ToS compliance =
 * perfect (it's just a URL, no API).
 *
 * Pure helpers, no I/O. Output is fed directly into the UI as
 *   { url: string; clipboardText?: string }
 * so the client can `window.open(url)` and (for comments where Reddit
 * has no `comment_text` URL param) drop the body on the user's clipboard
 * for one paste.
 */

const SUBREDDIT_RE = /^[A-Za-z0-9_]{2,21}$/;

function normalizeSubreddit(raw: string): string {
  // Accepts "r/foo", "/r/foo", "foo", "FOO_bar". Validates the resulting
  // slug because Reddit returns 404 + AutoMod silent-removal for malformed
  // ones — we'd rather throw locally than 404 out the user's click.
  const slug = raw.replace(/^\/?r\//i, '').trim();
  if (!SUBREDDIT_RE.test(slug)) {
    throw new Error(`Invalid subreddit slug "${raw}" — must be 2-21 chars [A-Za-z0-9_]`);
  }
  return slug;
}

/**
 * Build the URL for a brand-new self-post (text post). The user's
 * subsequent click → submit happens entirely in their authenticated
 * Reddit browser session.
 *
 * `title` is required by Reddit's composer (clicking submit on an empty
 * title field is rejected). Body is optional; when omitted the composer
 * shows an empty textarea ready for free typing.
 */
export function buildSubmitSelfPostUrl(opts: {
  subreddit: string;
  title: string;
  body?: string;
}): string {
  const sub = normalizeSubreddit(opts.subreddit);
  const params = new URLSearchParams({ title: opts.title });
  if (opts.body) {
    params.set('text', opts.body);
    params.set('selftext', 'true');
  }
  return `https://www.reddit.com/r/${encodeURIComponent(sub)}/submit?${params.toString()}`;
}

/**
 * Build the URL for a link-post. Same semantics as a self-post but the
 * Reddit composer pre-fills the URL field instead of the textarea.
 * Title is still required.
 */
export function buildSubmitLinkPostUrl(opts: {
  subreddit: string;
  title: string;
  url: string;
}): string {
  const sub = normalizeSubreddit(opts.subreddit);
  const params = new URLSearchParams({
    title: opts.title,
    url: opts.url,
  });
  return `https://www.reddit.com/r/${encodeURIComponent(sub)}/submit?${params.toString()}`;
}

/**
 * Comment payload. Reddit's composer URL has NO param for pre-filling a
 * comment body, so we hand back the post URL (UI calls window.open) plus
 * the body that the UI must drop on the clipboard. The user lands on the
 * comment box, hits paste, posts.
 *
 * `postUrl` is whatever permalink the scanner stored on the draft
 * (`presence_drafts.external_thread_url`). Pre-November 2025 permalinks
 * still resolve fine.
 */
export type RedditCommentPayload = {
  url: string;
  clipboardText: string;
};

export function buildCommentPayload(opts: {
  postUrl: string;
  body: string;
}): RedditCommentPayload {
  if (!/^https?:\/\/(www\.|old\.)?reddit\.com\//.test(opts.postUrl)) {
    throw new Error(`Not a Reddit URL: ${opts.postUrl}`);
  }
  return {
    url: opts.postUrl,
    clipboardText: opts.body,
  };
}
