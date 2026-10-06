import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ArgumentError } from '@jackwener/opencli/errors';
import { getRegistry } from '@jackwener/opencli/registry';
import { __test__ } from './publish.js';

describe('tiktok publish command registration', () => {
  it('registers tiktok/publish with the write contract', () => {
    const cmd = getRegistry().get('tiktok/publish');
    expect(cmd).toBeDefined();
    expect(cmd.access).toBe('write');
    expect(cmd.columns).toEqual(['status', 'url', 'post_id']);
  });

  it('declares videos as a required arg', () => {
    const cmd = getRegistry().get('tiktok/publish');
    const videos = cmd.args.find(a => a.name === 'videos');
    expect(videos).toBeDefined();
    expect(videos.required).toBe(true);
  });

  it('uses the studio upload page with the video tab', () => {
    const cmd = getRegistry().get('tiktok/publish');
    expect(cmd.domain).toBe('www.tiktok.com');
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
    const file = path.join(os.tmpdir(), `tt-publish-${Date.now()}.txt`);
    fs.writeFileSync(file, '  from file  ');
    try {
      expect(__test__.resolveContent({ file })).toBe('from file');
    } finally {
      fs.unlinkSync(file);
    }
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

  it('throws when an image path is placed in videos', () => {
    const file = path.join(os.tmpdir(), `tt-img-${Date.now()}.png`);
    fs.writeFileSync(file, 'x');
    try {
      expect(() => __test__.normalizeMediaFiles({ videos: file })).toThrow(ArgumentError);
    } finally {
      fs.unlinkSync(file);
    }
  });

  it('resolves and splits videos', () => {
    const vid = path.join(os.tmpdir(), `tt-vid-${Date.now()}.mp4`);
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

describe('requireSingleVideo', () => {
  it('accepts exactly one video', () => {
    const vid = path.join(os.tmpdir(), `tt-one-${Date.now()}.mp4`);
    fs.writeFileSync(vid, 'x');
    try {
      expect(__test__.requireSingleVideo([vid], 'tiktok')).toBe(vid);
    } finally {
      fs.unlinkSync(vid);
    }
  });

  it('rejects an empty list', () => {
    expect(() => __test__.requireSingleVideo([], 'tiktok')).toThrow(ArgumentError);
  });

  it('rejects more than one video', () => {
    expect(() => __test__.requireSingleVideo(['a.mp4', 'b.mp4'], 'tiktok')).toThrow(ArgumentError);
  });
});
