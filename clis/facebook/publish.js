import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, CommandExecutionError } from '@jackwener/opencli/errors';
import { log } from '@jackwener/opencli/logger';
import {
  COLUMNS,
  PHASE,
  resolveContent,
  normalizeMediaFiles,
  requireLogin,
  buildArgs,
  row,
  step,
  gotoWithRetry,
  fillEditor,
  attachMedia,
  uploadProbeJs,
  publishFinish,
  locateJs,
  waitFor,
  clickXpath,
  clickWhenReady,
  dismissOverlays,
  footerActionJs,
  resultProbeJs,
} from '../shared/publish-helpers.js';

const ENTRY_URL = 'https://www.facebook.com/';
const PROFILE_URL = 'https://www.facebook.com/me/';
const MAX_MEDIA = 10;
const ACTION_ATTR = 'data-opencli-fb-action';
const ID_PATTERN = /\/posts\/([^/?#]+)/;
const SITE_HINT = 'Facebook UI may have changed — re-check the composer semantic selectors';
const OWN_POST_PROBE = `(() => {
  const links = [...document.querySelectorAll('a[href]')].map(a => a.getAttribute('href') || '');
  const hit = links.find(h => /\\/posts\\/|story\\.php\\?story_fbid=|permalink\\.php\\?story_fbid=/.test(h));
  if (!hit) return { ok: false };
  return { ok: true, url: /^https?:/i.test(hit) ? hit : 'https://www.facebook.com' + hit };
})()`;

async function capturePostUrl(bp) {
  try {
    await waitFor(bp, OWN_POST_PROBE, 45000, '帖子链接', SITE_HINT);
  } catch {
    log.verbose('主页未找到新帖链接，保留空 url');
    return;
  }
  const found = await bp.evaluate(OWN_POST_PROBE);
  if (!found?.url) return;
  let url = found.url;
  const m = url.match(ID_PATTERN) || url.match(/story_fbid=([^&#]+)/);
  const postId = m ? (m[1] || '') : '';
  if (/\/posts\//.test(url)) url = url.split('?')[0];
  return { url, postId };
}

const X = {
  entry: [
    '//*[@role="region"][.//input[@type="file"]]//*[@role="button"]',
    '//*[@role="region"][.//input[contains(@accept,"image")]]//*[@role="button"]',
  ],
  editor: [
    '//*[@role="dialog"]//*[@role="textbox"]',
    '//*[@role="dialog"]//div[@contenteditable="true"]',
  ],
  fileInput: [
    '//*[@role="dialog"]//input[@type="file"]',
    '//input[@type="file"]',
  ],
};

async function clickPublish(bp) {
  const marked = await waitFor(bp, footerActionJs(ACTION_ATTR), 60000, '发布按钮', SITE_HINT);
  log.verbose(`发布按钮：<${marked.tag}> "${marked.label}"`);
  const clicked = await clickXpath(bp, [`//*[@${ACTION_ATTR}="1"]`]);
  if (!clicked?.ok) throw new CommandExecutionError('Facebook publish button not clickable', SITE_HINT);
  return clicked;
}

cli({
  site: 'facebook',
  name: 'publish',
  access: 'write',
  description: 'Publish a text/image/video post to your Facebook feed',
  domain: 'www.facebook.com',
  strategy: Strategy.UI,
  browser: true,
  siteSession: 'persistent',
  defaultWindowMode: 'foreground',
  args: buildArgs({ media: 'both' }),
  columns: COLUMNS,
  func: async (page, kwargs) => {
    const bp = page;
    if (!bp) throw new CommandExecutionError('Browser session required for facebook publish');
    await requireLogin(bp, ENTRY_URL, ['c_user'], 'www.facebook.com');
    log.status('已登录，开始整理发布内容');
    const content = resolveContent({ text: kwargs.text, file: kwargs.file });
    const { images, videos } = normalizeMediaFiles({ images: kwargs.images, videos: kwargs.videos });
    const media = [...images, ...videos];
    if (media.length > MAX_MEDIA) throw new ArgumentError(`Too many media files: ${media.length} (max ${MAX_MEDIA})`);
    if (!content && media.length === 0) throw new ArgumentError('Provide --text/--file or --images/--videos (nothing to publish)');
    const timeout = Number(kwargs.timeout) || 180;
    const dryRun = Boolean(kwargs['dry-run'] ?? kwargs.dryRun);
    log.status(`内容 ${content.length} 字，媒体 ${media.length} 个${dryRun ? '（dry-run）' : ''}`);

    await step(bp, PHASE.open, () => gotoWithRetry(bp, ENTRY_URL), 2.4, 4.8);
    await step(bp, PHASE.overlay, () => dismissOverlays(bp, 2), 0.8, 1.6);
    await step(bp, PHASE.entry, () => clickWhenReady(bp, X.entry, 45000, '发帖入口', SITE_HINT), 2.4, 4.8);

    const editor = await step(bp, PHASE.editor, () => waitFor(bp, locateJs(X.editor, 'data-opencli-fb-editor'), 30000, '发帖对话框', SITE_HINT), 1.5, 3);
    if (!editor?.ok) throw new CommandExecutionError('Facebook composer textbox not found', SITE_HINT);
    log.verbose(`内容框选择器：${editor.selector}`);

    if (media.length) {
      await step(bp, PHASE.media, () => attachMedia(bp, {
        files: media,
        pasteTargets: X.editor,
        fileInputXpaths: X.fileInput,
        acceptHint: 'image',
        readyProbeJs: uploadProbeJs(media.length, [], ["couldn't be uploaded", '无法上传', 'not supported', '不支持']),
        pasteTimeoutMs: 25000,
        readyTimeoutMs: 60000,
        label: '媒体',
        hint: SITE_HINT,
      }), 2.4, 4.8);
      log.status(`已附加 ${media.length} 个媒体文件`);
    }

    if (content) await step(bp, PHASE.text, () => fillEditor(bp, editor.selector, content, locateJs(X.editor, 'data-opencli-fb-editor')), 1.5, 3);
    await step(bp, PHASE.settings, async () => { log.verbose('Facebook 无发布前设置，跳过'); }, 0.2, 0.4);
    if (dryRun) {
      log.status('dry-run 完成，跳过发布按钮');
      return row('dry_run');
    }
    await step(bp, PHASE.publish, () => clickPublish(bp), 1.5, 3);
    const out = await publishFinish(bp, {
      probeJs: resultProbeJs({
        goneSelector: '[role="dialog"]',
        urlPattern: 'permalink\\.php|/posts/|story_fbid',
        texts: ['已发布', '已分享', 'your post', '发布成功'],
      }),
      timeoutMs: Math.min(timeout * 1000, 90000),
      hint: SITE_HINT,
      idPattern: ID_PATTERN,
      stripQuery: true,
    });
    if (!out[0]?.url) {
      await step(bp, '· 跳转主页捕获帖子链接', () => gotoWithRetry(bp, PROFILE_URL), 2.4, 4.8);
      const found = await capturePostUrl(bp);
      if (found) {
        out[0].url = found.url;
        out[0].post_id = found.postId;
        log.status(`已捕获帖子链接：${found.url}`);
      }
    }
    return out;
  },
});

export const __test__ = {
  resolveContent,
  normalizeMediaFiles,
  X,
};
