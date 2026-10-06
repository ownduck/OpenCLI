import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ArgumentError } from '@jackwener/opencli/errors';
import { getRegistry } from '@jackwener/opencli/registry';
import { __test__ } from './publish.js';

describe('twitter publish command registration', () => {
  it('registers twitter/publish with the write contract', () => {
    const cmd = getRegistry().get('twitter/publish');
    expect(cmd).toBeDefined();
    expect(cmd.access).toBe('write');
    expect(cmd.columns).toEqual(['status', 'url', 'post_id']);
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
