import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { JSDOM } from 'jsdom';
import { ArgumentError } from '@jackwener/opencli/errors';
import { getRegistry } from '@jackwener/opencli/registry';
import { __test__ } from './publish.js';

describe('twitter publish command registration', () => {
  it('registers twitter/publish with the write contract', () => {
    const cmd = getRegistry().get('twitter/publish');
    expect(cmd).toBeDefined();
    expect(cmd.access).toBe('write');
    expect(cmd.columns).toEqual(['status']);
  });

  it('keeps text optional and images optional', () => {
    const cmd = getRegistry().get('twitter/publish');
    expect(cmd.args.find(a => a.name === 'text').required).toBeFalsy();
    expect(cmd.args.find(a => a.name === 'images').required).toBeFalsy();
  });
});

describe('resolveContent', () => {
  it('returns raw text as-is', () => {
    expect(__test__.resolveContent({ text: '  hello world  ' })).toBe('hello world');
  });

  it('returns empty string when nothing provided', () => {
    expect(__test__.resolveContent({})).toBe('');
  });

  it('reads --file path content', () => {
    const file = path.join(os.tmpdir(), `tw-publish-${Date.now()}.txt`);
    fs.writeFileSync(file, '  from file  ');
    try {
      expect(__test__.resolveContent({ file })).toBe('from file');
    } finally {
      fs.unlinkSync(file);
    }
  });

  it('auto-reads a .txt path passed as positional text', () => {
    const file = path.join(os.tmpdir(), `tw-publish-${Date.now()}.txt`);
    fs.writeFileSync(file, 'auto txt');
    try {
      expect(__test__.resolveContent({ text: file })).toBe('auto txt');
    } finally {
      fs.unlinkSync(file);
    }
  });

  it('throws ArgumentError when --file is missing', () => {
    expect(() => __test__.resolveContent({ file: '/no/such/file.txt' })).toThrow(ArgumentError);
  });
});

describe('normalizeMediaFiles', () => {
  it('throws when an image file is missing', () => {
    expect(() => __test__.normalizeMediaFiles({ images: '/no/such.png' })).toThrow(ArgumentError);
  });

  it('throws on unsupported format', () => {
    const file = path.join(os.tmpdir(), `tw-bad-${Date.now()}.pdf`);
    fs.writeFileSync(file, 'x');
    try {
      expect(() => __test__.normalizeMediaFiles({ images: file })).toThrow(ArgumentError);
    } finally {
      fs.unlinkSync(file);
    }
  });

  it('throws when a video path is placed in images', () => {
    const file = path.join(os.tmpdir(), `tw-vid-${Date.now()}.mp4`);
    fs.writeFileSync(file, 'x');
    try {
      expect(() => __test__.normalizeMediaFiles({ images: file })).toThrow(ArgumentError);
    } finally {
      fs.unlinkSync(file);
    }
  });

  it('resolves and splits images', () => {
    const img = path.join(os.tmpdir(), `tw-img-${Date.now()}.png`);
    fs.writeFileSync(img, 'x');
    try {
      const r = __test__.normalizeMediaFiles({ images: img });
      expect(r.images).toEqual([img]);
      expect(r.videos).toEqual([]);
    } finally {
      fs.unlinkSync(img);
    }
  });
});

describe('POSTABLE_PROBE', () => {
  function runProbe(html) {
    const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, {
      url: 'https://x.com/compose/post',
      runScripts: 'outside-only',
    });
    return dom.window.eval(__test__.POSTABLE_PROBE);
  }

  it('reads over-limit from countdown-circle', () => {
    const st = runProbe(`
      <div data-testid="countdown-circle">
        <div aria-live="polite">You have exceeded the character limit by 715</div>
        <div>-715</div>
      </div>
      <button data-testid="tweetButtonInline" disabled aria-disabled="true">Post</button>
    `);
    expect(st).toEqual({ ok: false, over: 715 });
  });

  it('returns disabled without over when circle absent (e.g. media pending)', () => {
    const st = runProbe(`<button data-testid="tweetButtonInline" disabled aria-disabled="true">Post</button>`);
    expect(st).toEqual({ ok: false, over: null });
  });

  it('returns ok when any Post is enabled (bottom tweetButton vs disabled inline)', () => {
    const st = runProbe(`
      <button data-testid="tweetButton">Post</button>
      <button data-testid="tweetButtonInline" disabled aria-disabled="true">Post</button>
    `);
    expect(st).toEqual({ ok: true });
  });
});

describe('mediaReadyJs', () => {
  it('requires attachment preview, not just file input.files', () => {
    const dom = new JSDOM(`<!doctype html><body>
      <input type="file" />
      <div data-testid="attachments"><div role="group"><img src="blob:https://x.com/a" /></div></div>
    </body>`, { url: 'https://x.com/compose/post', runScripts: 'outside-only' });
    // simulate a file selected on input without preview elsewhere
    const input = dom.window.document.querySelector('input');
    Object.defineProperty(input, 'files', { value: { length: 1 }, configurable: true });
    expect(dom.window.eval(__test__.mediaReadyJs(1)).ok).toBe(true);

    const empty = new JSDOM(`<!doctype html><body><input type="file" /></body>`, {
      url: 'https://x.com/compose/post',
      runScripts: 'outside-only',
    });
    const inp = empty.window.document.querySelector('input');
    Object.defineProperty(inp, 'files', { value: { length: 1 }, configurable: true });
    expect(empty.window.eval(__test__.mediaReadyJs(1))).toMatchObject({ ok: false, preview: 0 });
  });
});
