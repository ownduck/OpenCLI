import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, CommandExecutionError } from '@jackwener/opencli/errors';
import { log } from '@jackwener/opencli/logger';
import {
  COLUMNS,
  PHASE,
  resolveContent,
  classifyMedia,
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
  clickWhenReady,
  dismissOverlays,
  resultProbeJs,
} from '../shared/publish-helpers.js';

const ENTRY_URL = 'https://x.com/home';
const MAX_MEDIA = 4;
const ID_PATTERN = /status\/(\d+)/;
const SITE_HINT = 'X/Twitter UI may have changed — re-check the composer semantic selectors';

const X = {
  entry: [
    '//*[@data-testid="SideNav_NewTweet_Button"]',
    '//*[@data-testid="FloatingSideNav_NewTweet_Button"]',
  ],
  editor: [
    '//*[@data-testid="tweetTextarea_0"]',
    '//*[@role="dialog"]//div[@role="textbox"]',
    '//div[@role="textbox"]',
  ],
  fileInput: [
    '//*[@role="dialog"]//input[@type="file"]',
    '//input[@type="file"]',
  ],
  publishBtn: [
    '//*[@data-testid="tweetButtonInline"]',
    '//*[@data-testid="tweetButton"]',
    '//*[@role="dialog"]//button[@type="submit"]',
  ],
};

const INLINE_PROBE = `(() => ({ ok: !!document.querySelector('[data-testid="tweetTextarea_0"]') }))()`;

async function openComposer(bp) {
  try {
    await waitFor(bp, INLINE_PROBE, 25000, '首页内联发帖框', SITE_HINT);
    log.verbose('首页内联发帖框已就绪，无需点击入口');
    return;
  } catch {
    log.verbose('首页无内联发帖框，点击侧栏发帖入口');
  }
  await clickWhenReady(bp, X.entry, 30000, '发帖入口', SITE_HINT);
}

cli({
  site: 'twitter',
  name: 'publish',
  access: 'write',
  description: 'Publish a text/image post to X (Twitter)',
  domain: 'x.com',
  strategy: Strategy.UI,
  browser: true,
  siteSession: 'persistent',
  defaultWindowMode: 'foreground',
  args: buildArgs({ media: 'image' }),
  columns: COLUMNS,
  func: async (page, kwargs) => {
    const bp = page;
    if (!bp) throw new CommandExecutionError('Browser session required for twitter publish');
    await requireLogin(bp, ENTRY_URL, ['auth_token', 'ct0'], 'x.com');
    log.status('已登录，开始整理发布内容');
    const content = resolveContent({ text: kwargs.text, file: kwargs.file });
    const { images } = normalizeMediaFiles({ images: kwargs.images });
    if (images.length > MAX_MEDIA) throw new ArgumentError(`Too many images: ${images.length} (max ${MAX_MEDIA})`);
    if (!content && images.length === 0) throw new ArgumentError('Provide --text/--file or --images (nothing to publish)');
    const timeout = Number(kwargs.timeout) || 180;
    const dryRun = Boolean(kwargs['dry-run'] ?? kwargs.dryRun);
    log.status(`内容 ${content.length} 字，图片 ${images.length} 个${dryRun ? '（dry-run）' : ''}`);

    await step(bp, PHASE.open, () => gotoWithRetry(bp, ENTRY_URL), 2.4, 4.8);
    await step(bp, PHASE.overlay, () => dismissOverlays(bp, 2), 0.8, 1.6);
    await step(bp, PHASE.entry, () => openComposer(bp), 1.5, 3);

    const editor = await step(bp, PHASE.editor, () => waitFor(bp, locateJs(X.editor, 'data-opencli-tw-editor'), 30000, '发帖内容框', SITE_HINT), 1.5, 3);
    if (!editor?.ok) throw new CommandExecutionError('X composer textbox not found', SITE_HINT);
    log.verbose(`内容框选择器：${editor.selector}`);

    if (images.length) {
      await step(bp, PHASE.media, () => attachMedia(bp, {
        files: images,
        pasteTargets: X.editor,
        fileInputXpaths: X.fileInput,
        acceptHint: 'image',
        readyProbeJs: uploadProbeJs(images.length, [], ['could not be processed', 'unsupported', '不支持']),
        pasteTimeoutMs: 25000,
        readyTimeoutMs: 60000,
        label: '图片',
        hint: SITE_HINT,
      }), 2.4, 4.8);
      log.status(`已附加 ${images.length} 个图片`);
    }

    if (content) await step(bp, PHASE.text, () => fillEditor(bp, editor.selector, content), 1.5, 3);
    await step(bp, PHASE.settings, async () => { log.verbose('X 无发布前设置，跳过'); }, 0.2, 0.4);
    if (dryRun) {
      log.status('dry-run 完成，跳过发布按钮');
      return row('dry_run');
    }
    await step(bp, PHASE.publish, () => clickWhenReady(bp, X.publishBtn, 45000, '发布按钮', SITE_HINT), 1.5, 3);
    return publishFinish(bp, {
      probeJs: resultProbeJs({
        goneSelector: '[data-testid="tweetButton"], [data-testid="tweetButtonInline"]',
        urlPattern: '/status/\\d+',
        texts: ['your post was sent', '已发布', '已发送'],
        base: 'https://x.com',
      }),
      timeoutMs: timeout * 1000,
      hint: SITE_HINT,
      idPattern: ID_PATTERN,
    });
  },
});

export const __test__ = {
  resolveContent,
  classifyMedia,
  normalizeMediaFiles,
  X,
};
