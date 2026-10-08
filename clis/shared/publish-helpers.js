/**
 * 六站 publish 共用：正文/媒体参数、步骤文案、status 输出。
 * DOM/CDP 逻辑已迁至 Playwright（见 pw-session.js）。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ArgumentError } from '@jackwener/opencli/errors';

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp']);
const VIDEO_EXT = new Set(['.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v']);

export const STATUS_COLUMNS = ['status'];
/** @deprecated 使用 STATUS_COLUMNS */
export const COLUMNS = STATUS_COLUMNS;

export const statusRow = (status) => [{ status }];
/** @deprecated 使用 statusRow；忽略 url/postId */
export function row(status) {
  return statusRow(status);
}

export const PHASE = {
  open: '1 打开发布入口页',
  overlay: '2 清理页面遮罩',
  entry: '3 触发发布入口',
  editor: '4 等待内容编辑框',
  media: '5 附加媒体',
  text: '6 填写正文',
  settings: '7 发布前设置',
  publish: '8 点击发布按钮',
  result: '9 等待发布结果',
};

export function resolveContent({ text, file }) {
  const textStr = String(text ?? '').trim();
  const fileStr = String(file ?? '').trim();
  if (fileStr) {
    if (!fs.existsSync(fileStr) || !fs.statSync(fileStr).isFile()) {
      throw new ArgumentError(`Content file not found: ${fileStr}`, 'Pass a readable .txt path to --file');
    }
    return fs.readFileSync(fileStr, 'utf8').trim();
  }
  if (textStr) {
    if (/\.txt$/i.test(textStr) && fs.existsSync(textStr) && fs.statSync(textStr).isFile()) {
      return fs.readFileSync(textStr, 'utf8').trim();
    }
    return textStr;
  }
  return '';
}

function classifyMedia(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (IMAGE_EXT.has(ext)) return 'image';
  if (VIDEO_EXT.has(ext)) return 'video';
  return 'unsupported';
}

export function normalizeMediaFiles({ images = '', videos = '', maxVideos = null, site = '' } = {}) {
  const one = (raw, kind) => raw.split(',').map((s) => s.trim()).filter(Boolean).map((p) => {
    const abs = path.resolve(p);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      throw new ArgumentError(`Media file not found: ${abs}`, 'Provide absolute or relative paths to local files');
    }
    const cls = classifyMedia(abs);
    if (cls === 'unsupported') {
      throw new ArgumentError(
        `Unsupported media format: ${path.extname(abs)}`,
        'Supported images: jpg/png/gif/webp/bmp; videos: mp4/mov/avi/mkv/webm/m4v',
      );
    }
    if (cls !== kind) {
      throw new ArgumentError(`Expected ${kind} but got ${cls}: ${abs}`, 'Use --images for images and --videos for videos');
    }
    return abs;
  });
  const out = { images: one(String(images ?? ''), 'image'), videos: one(String(videos ?? ''), 'video') };
  if (maxVideos != null) {
    const label = site || 'publish';
    if (out.videos.length === 0) {
      throw new ArgumentError(`${label} publish requires a video`, 'Pass --videos <path> (mp4/mov/avi/mkv/webm/m4v)');
    }
    if (out.videos.length > maxVideos) {
      throw new ArgumentError(`${label} publish accepts one video, got ${out.videos.length}`, 'Pass a single --videos path');
    }
  }
  return out;
}

export function buildArgs({ media = 'image', timeout = 180, requiredMedia = false } = {}) {
  const args = [
    { name: 'text', positional: true, required: false, help: 'Post body text, or a path to a .txt file (auto-read)' },
    { name: 'file', type: 'string', required: false, help: 'Path to a .txt file whose content becomes the post body' },
  ];
  if (media === 'image' || media === 'both') {
    args.push({
      name: 'images',
      type: 'string',
      required: requiredMedia && media === 'image',
      help: 'Comma-separated local image paths (jpg/png/gif/webp/bmp)',
    });
  }
  if (media === 'video' || media === 'both') {
    args.push({
      name: 'videos',
      type: 'string',
      required: media === 'video',
      help: 'Local video path (mp4/mov/avi/mkv/webm/m4v)',
    });
  }
  args.push({ name: 'dry-run', type: 'bool', default: false, help: 'Fill draft until the final publish control is located; do not click it' });
  args.push({ name: 'timeout', type: 'int', default: timeout, help: `Max seconds for the publish command (default: ${timeout})` });
  return args;
}
