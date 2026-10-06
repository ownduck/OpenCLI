import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ArgumentError } from '@jackwener/opencli/errors';
import { getRegistry } from '@jackwener/opencli/registry';
import { __test__ } from './publish.js';

describe('facebook publish command registration', () => {
  it('registers facebook/publish with the write contract', () => {
    const cmd = getRegistry().get('facebook/publish');
    expect(cmd).toBeDefined();
    expect(cmd.access).toBe('write');
    expect(cmd.columns).toEqual(['status', 'url', 'post_id']);
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
    const file = path.join(os.tmpdir(), `fb-publish-${Date.now()}.txt`);
    fs.writeFileSync(file, '  from file  ');
    try {
      expect(__test__.resolveContent({ file })).toBe('from file');
    } finally {
      fs.unlinkSync(file);
    }
  });

  it('auto-reads a .txt path passed as positional text', () => {
    const file = path.join(os.tmpdir(), `fb-publish-${Date.now()}.txt`);
    fs.writeFileSync(file, 'auto txt');
    try {
      expect(__test__.resolveContent({ text: file })).toBe('auto txt');
    } finally {
      fs.unlinkSync(file);
    }
  });

  it('treats a non-existent .txt path as literal text', () => {
    expect(__test__.resolveContent({ text: '/no/such/file.txt' })).toBe('/no/such/file.txt');
  });

  it('throws ArgumentError when --file is missing', () => {
    expect(() => __test__.resolveContent({ file: '/no/such/file.txt' })).toThrow(ArgumentError);
  });
});

describe('normalizeMediaFiles', () => {
  it('throws when a media file is missing', () => {
    expect(() => __test__.normalizeMediaFiles({ images: '/no/such.png' })).toThrow(ArgumentError);
  });

  it('throws on unsupported format', () => {
    expect(() => __test__.normalizeMediaFiles({ videos: '/no/such.pdf' })).toThrow(ArgumentError);
  });

  it('throws when an image path is placed in videos', () => {
    const file = path.join(os.tmpdir(), `fb-img-${Date.now()}.png`);
    fs.writeFileSync(file, 'x');
    try {
      expect(() => __test__.normalizeMediaFiles({ videos: file })).toThrow(ArgumentError);
    } finally {
      fs.unlinkSync(file);
    }
  });

  it('resolves and splits images and videos', () => {
    const img = path.join(os.tmpdir(), `fb-img-${Date.now()}.png`);
    const vid = path.join(os.tmpdir(), `fb-vid-${Date.now()}.mp4`);
    fs.writeFileSync(img, 'x');
    fs.writeFileSync(vid, 'x');
    try {
      const r = __test__.normalizeMediaFiles({ images: img, videos: vid });
      expect(r.images).toEqual([img]);
      expect(r.videos).toEqual([vid]);
    } finally {
      fs.unlinkSync(img);
      fs.unlinkSync(vid);
    }
  });
});
