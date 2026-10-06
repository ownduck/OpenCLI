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
  humanWait,
  gotoWithRetry,
  fillEditor,
  attachMedia,
  uploadProbeJs,
  publishFinish,
  locateJs,
  waitFor,
  clickWhenReady,
  dismissOverlays,
  footerActionJs,
  resultProbeJs,
} from '../shared/publish-helpers.js';

const ENTRY_URL = 'https://www.linkedin.com/preload/sharebox/';
const MAX_MEDIA = 9;
const ACTION_ATTR = 'data-opencli-li-action';
const ID_PATTERN = /(?:share|activity):(\d+)/;
const SITE_HINT = 'LinkedIn UI may have changed — re-check the composer page semantic selectors';

const X = {
  editor: [
    '//div[@role="textbox"]',
    '//div[contains(@class, "ql-editor")]',
    '//div[@contenteditable="true"]',
  ],
  fileInput: [
    '//input[@type="file"]',
  ],
  publishBtn: [
    '//button[contains(@class, "share-actions__primary-action")]',
    '//*[@role="dialog"]//button[contains(@class, "artdeco-button--primary")]',
  ],
};

const DIALOG_PROBE = `(() => ({ ok: !!document.querySelector('[role="dialog"]') }))()`;
const URL_PROBE = `(() => ({ url: location.href }))()`;

async function clickPublish(bp) {
  for (let i = 1; i <= 2; i++) {
    try {
      await clickWhenReady(bp, X.publishBtn, 30000, '发布按钮', SITE_HINT);
    } catch {
      await waitFor(bp, footerActionJs(ACTION_ATTR), 20000, '发布按钮（兜底）', SITE_HINT);
      await clickWhenReady(bp, [`//*[@${ACTION_ATTR}="1"]`], 15000, '发布按钮（兜底点击）', SITE_HINT);
    }
    await humanWait(bp, 1.5, 3);
    if (!(await bp.evaluate(DIALOG_PROBE))?.ok) return true;
    if (/urn:li:(share|activity)/.test((await bp.evaluate(URL_PROBE))?.url || '')) return true;
    log.verbose(`发布按钮第 ${i} 次点击后发帖框仍在，重试`);
  }
  throw new CommandExecutionError('LinkedIn 发帖框在点击发布后未关闭', '可能被限流（今日发布上限）、内容为空或需要二次验证 — 请到 linkedin.com 手动确认后再重试');
}

cli({
  site: 'linkedin',
  name: 'publish',
  access: 'write',
  description: 'Publish a text/image post to your LinkedIn feed',
  domain: 'www.linkedin.com',
  strategy: Strategy.UI,
  browser: true,
  siteSession: 'persistent',
  defaultWindowMode: 'foreground',
  args: buildArgs({ media: 'image' }),
  columns: COLUMNS,
  func: async (page, kwargs) => {
    const bp = page;
    if (!bp) throw new CommandExecutionError('Browser session required for linkedin publish');
    await requireLogin(bp, ENTRY_URL, ['li_at'], 'www.linkedin.com');
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
    await step(bp, PHASE.entry, async () => { log.verbose('入口页即发帖框，无需额外触发'); }, 0.2, 0.4);

    const editor = await step(bp, PHASE.editor, () => waitFor(bp, locateJs(X.editor, 'data-opencli-li-editor'), 45000, '发帖内容框', SITE_HINT), 1.5, 3);
    if (!editor?.ok) throw new CommandExecutionError('LinkedIn composer textbox not found', SITE_HINT);
    log.verbose(`内容框选择器：${editor.selector}`);

    if (images.length) {
      await step(bp, PHASE.media, () => attachMedia(bp, {
        files: images,
        pasteTargets: X.editor,
        fileInputXpaths: X.fileInput,
        acceptHint: 'image',
        readyProbeJs: uploadProbeJs(images.length, ['编辑预览', '删除媒体文件'], ['unsupported', '不支持']),
        pasteTimeoutMs: 25000,
        readyTimeoutMs: 60000,
        label: '图片',
        hint: SITE_HINT,
      }), 2.4, 4.8);
      log.status(`已附加 ${images.length} 个图片`);
    }

    if (content) await step(bp, PHASE.text, () => fillEditor(bp, editor.selector, content), 1.5, 3);
    await step(bp, PHASE.settings, async () => { log.verbose('LinkedIn 无发布前设置，跳过'); }, 0.2, 0.4);
    if (dryRun) {
      log.status('dry-run 完成，跳过发布按钮');
      return row('dry_run');
    }
    await step(bp, PHASE.publish, () => clickPublish(bp), 1.5, 3);
    return publishFinish(bp, {
      probeJs: resultProbeJs({
        goneSelector: '[role="dialog"]',
        urlPattern: 'urn:li:(share|activity)',
        texts: ['已发布', '发布成功', 'post was published'],
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
