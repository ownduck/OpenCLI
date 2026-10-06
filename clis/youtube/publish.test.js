import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ArgumentError } from '@jackwener/opencli/errors';
import { getRegistry } from '@jackwener/opencli/registry';
import { __test__ } from './publish.js';

describe('youtube publish command registration', () => {
  it('registers youtube/publish with the write contract', () => {
    const cmd = getRegistry().get('youtube/publish');
    expect(cmd).toBeDefined();
    expect(cmd.access).toBe('write');
    expect(cmd.columns).toEqual(['status', 'url', 'post_id']);
  });

  it('declares videos as a required arg', () => {
    const cmd = getRegistry().get('youtube/publish');
    const videos = cmd.args.find(a => a.name === 'videos');
    expect(videos).toBeDefined();
    expect(videos.required).toBe(true);
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
    const file = path.join(os.tmpdir(), `yt-publish-${Date.now()}.txt`);
    fs.writeFileSync(file, '  from file  ');
    try {
      expect(__test__.resolveContent({ file })).toBe('from file');
    } finally {
      fs.unlinkSync(file);
    }
  });

  it('auto-reads a .txt path passed as positional text', () => {
    const file = path.join(os.tmpdir(), `yt-publish-${Date.now()}.txt`);
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

describe('classifyMedia', () => {
  it('classifies videos', () => {
    expect(__test__.classifyMedia('c.mp4')).toBe('video');
    expect(__test__.classifyMedia('d.mov')).toBe('video');
  });

  it('returns unsupported for unknown extensions', () => {
    expect(__test__.classifyMedia('e.pdf')).toBe('unsupported');
  });
});

describe('normalizeMediaFiles', () => {
  it('throws when a video file is missing', () => {
    expect(() => __test__.normalizeMediaFiles({ videos: '/no/such.mp4' })).toThrow(ArgumentError);
  });

  it('throws on unsupported format', () => {
    expect(() => __test__.normalizeMediaFiles({ videos: '/no/such.pdf' })).toThrow(ArgumentError);
  });

  it('throws when an image path is placed in videos', () => {
    const file = path.join(os.tmpdir(), `yt-img-${Date.now()}.png`);
    fs.writeFileSync(file, 'x');
    try {
      expect(() => __test__.normalizeMediaFiles({ videos: file })).toThrow(ArgumentError);
    } finally {
      fs.unlinkSync(file);
    }
  });

  it('resolves and splits videos', () => {
    const vid = path.join(os.tmpdir(), `yt-vid-${Date.now()}.mp4`);
    fs.writeFileSync(vid, 'x');
    try {
      const r = __test__.normalizeMediaFiles({ videos: vid });
      expect(r.videos).toEqual([vid]);
      expect(r.images).toEqual([]);
    } finally {
      fs.unlinkSync(vid);
    }
  });
});
