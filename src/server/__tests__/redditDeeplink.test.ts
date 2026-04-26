import { describe, expect, test } from 'bun:test';
import {
  buildCommentPayload,
  buildSubmitLinkPostUrl,
  buildSubmitSelfPostUrl,
} from '../lib/redditDeeplink';

describe('buildSubmitSelfPostUrl', () => {
  test('builds a basic submit URL with title + body', () => {
    const url = buildSubmitSelfPostUrl({
      subreddit: 'rust',
      title: 'Hello world',
      body: 'This is a body.',
    });
    expect(url).toContain('https://www.reddit.com/r/rust/submit?');
    expect(url).toContain('title=Hello+world');
    expect(url).toContain('text=This+is+a+body.');
    expect(url).toContain('selftext=true');
  });

  test('omits text + selftext params when body is missing', () => {
    const url = buildSubmitSelfPostUrl({ subreddit: 'rust', title: 'Hi' });
    expect(url).not.toContain('text=');
    expect(url).not.toContain('selftext=');
  });

  test('strips a leading r/ or /r/ prefix from the subreddit', () => {
    expect(buildSubmitSelfPostUrl({ subreddit: 'r/rust', title: 'a' })).toContain('/r/rust/');
    expect(buildSubmitSelfPostUrl({ subreddit: '/r/rust', title: 'a' })).toContain('/r/rust/');
  });

  test('percent-encodes special characters in title and body', () => {
    const url = buildSubmitSelfPostUrl({
      subreddit: 'rust',
      title: 'Q&A: what about <T>?',
      body: 'Use & to combine; > matters.',
    });
    expect(url).toContain('title=Q%26A');
    expect(url).toContain('text=Use+%26');
  });

  test('rejects malformed subreddit slugs', () => {
    expect(() => buildSubmitSelfPostUrl({ subreddit: '', title: 'a' })).toThrow();
    expect(() => buildSubmitSelfPostUrl({ subreddit: 'a', title: 'a' })).toThrow(); // <2 chars
    expect(() => buildSubmitSelfPostUrl({ subreddit: 'a'.repeat(22), title: 'a' })).toThrow();
    expect(() => buildSubmitSelfPostUrl({ subreddit: 'has space', title: 'a' })).toThrow();
    expect(() => buildSubmitSelfPostUrl({ subreddit: 'has-dash', title: 'a' })).toThrow();
  });
});

describe('buildSubmitLinkPostUrl', () => {
  test('builds a link-post URL with url param', () => {
    const url = buildSubmitLinkPostUrl({
      subreddit: 'webdev',
      title: 'Cool tool',
      url: 'https://example.com/tool',
    });
    expect(url).toContain('/r/webdev/submit?');
    expect(url).toContain('title=Cool+tool');
    expect(url).toContain('url=https%3A%2F%2Fexample.com%2Ftool');
  });
});

describe('buildCommentPayload', () => {
  test('returns post URL + clipboard body when given a www.reddit URL', () => {
    const out = buildCommentPayload({
      postUrl: 'https://www.reddit.com/r/rust/comments/abc/hello/',
      body: 'My take.',
    });
    expect(out.url).toBe('https://www.reddit.com/r/rust/comments/abc/hello/');
    expect(out.clipboardText).toBe('My take.');
  });

  test('accepts old.reddit.com permalinks', () => {
    const out = buildCommentPayload({
      postUrl: 'https://old.reddit.com/r/rust/comments/abc/hello/',
      body: 'reply',
    });
    expect(out.url).toContain('old.reddit.com');
  });

  test('rejects non-Reddit URLs', () => {
    expect(() => buildCommentPayload({ postUrl: 'https://example.com/x', body: 'a' })).toThrow(
      /Not a Reddit URL/,
    );
  });
});
