import { cli, Strategy } from '@jackwener/opencli/registry';
import { CommandExecutionError } from '@jackwener/opencli/errors';
import { log } from '@jackwener/opencli/logger';
import {
  COLUMNS,
  PHASE,
  resolveContent,
  classifyMedia,
  normalizeMediaFiles,
  requireSingleVideo,
  requireLogin,
  buildArgs,
  row,
  step,
  humanWait,
  waitFor,
  gotoWithRetry,
  fillEditor,
  attachMedia,
  publishFinish,
  locateAllJs,
  locatePredicateJs,
  clickJs,
  clickWhenReady,
  dismissOverlays,
  resultProbeJs,
} from '../shared/publish-helpers.js';

const ENTRY_URL = 'https://studio.youtube.com';
const TITLE_MAX = 90;
const ID_PATTERN = /[?&]v=([^&#]+)/;
const SITE_HINT = 'YouTube UI may have changed — re-check the upload dialog semantic selectors';

const X = {
  entry: [
    '//*[@id="upload-icon"]',
    '//ytcp-icon-button[@id="upload-icon"]',
  ],
  menuItem: [
    '//a[contains(@href, "/upload")]',
    '//tp-yt-paper-icon-item[.//*[contains(@href, "/upload")]]',
  ],
  fileInput: [
    '//ytcp-uploads-dialog//input[@type="file"]',
    '//input[@type="file"]',
  ],
  editor: [
    '//ytcp-uploads-dialog//div[@role="textbox"]',
    '//div[@role="textbox"]',
  ],
  nextBtn: [
    '//*[@id="next-button"]',
    '//ytcp-uploads-dialog//ytcp-button[@id="next-button"]',
  ],
  publishBtn: [
    '//*[@id="done-button"]',
    '//ytcp-uploads-dialog//ytcp-button[@id="done-button"]',
  ],
  kidsNo: [
    '//ytkc-made-for-kids-select//tp-yt-paper-radio-button[2]',
  ],
  visibilityPublic: [
    '//ytcp-video-visibility-select//tp-yt-paper-radio-button[3]',
  ],
};

const DIALOG_PROBE = `(() => ({ ok: !!document.querySelector('ytcp-uploads-dialog') }))()`;

async function openUploadDialog(bp) {
  await clickWhenReady(bp, X.entry, 30000, '上传入口', SITE_HINT);
  try {
    await waitFor(bp, DIALOG_PROBE, 20000, '上传对话框', SITE_HINT);
    return;
  } catch {
    log.verbose('入口未直接打开对话框，尝试点击上传菜单项');
  }
  await clickWhenReady(bp, X.menuItem, 15000, '上传视频菜单项', SITE_HINT);
  await waitFor(bp, DIALOG_PROBE, 30000, '上传对话框', SITE_HINT);
}

async function applySettings(bp) {
  const kids = await bp.evaluate(clickJs(X.kidsNo));
  log.status(kids?.ok ? '· 已设置"非儿童内容"' : '· 未找到儿童内容选项，跳过');
  for (let i = 1; i <= 3; i++) {
    if ((await bp.evaluate(DIALOG_PROBE)) && (await bp.evaluate(`(() => ({ ok: !!document.querySelector('ytcp-video-visibility-select') }))()`))?.ok) break;
    try {
      await clickWhenReady(bp, X.nextBtn, 30000, `继续（第 ${i} 步）`, SITE_HINT);
      log.status(`· 已点击继续（第 ${i} 步）`);
      await humanWait(bp, 1.5, 3);
    } catch { break; }
  }
  const pub = await bp.evaluate(clickJs(X.visibilityPublic));
  log.status(pub?.ok ? '· 已设置公开范围：公开' : '· 未找到公开范围选项，跳过');
}

cli({
  site: 'youtube',
  name: 'publish',
  access: 'write',
  description: 'Upload a video with a title/description to YouTube',
  domain: 'www.youtube.com',
  strategy: Strategy.UI,
  browser: true,
  siteSession: 'persistent',
  defaultWindowMode: 'foreground',
  args: buildArgs({ media: 'video', timeout: 300, requiredMedia: true }),
  columns: COLUMNS,
  func: async (page, kwargs) => {
    const bp = page;
    if (!bp) throw new CommandExecutionError('Browser session required for youtube publish');
    await requireLogin(bp, 'https://www.youtube.com', ['SID', 'SAPISID', '__Secure-1PSID'], 'www.youtube.com');
    log.status('已登录，开始整理发布内容');
    const content = resolveContent({ text: kwargs.text, file: kwargs.file });
    const { videos } = normalizeMediaFiles({ videos: kwargs.videos });
    const video = requireSingleVideo(videos, 'youtube');
    const timeout = Number(kwargs.timeout) || 300;
    const dryRun = Boolean(kwargs['dry-run'] ?? kwargs.dryRun);
    log.status(`内容 ${content.length} 字，视频 1 个${dryRun ? '（dry-run）' : ''}`);

    await step(bp, PHASE.open, () => gotoWithRetry(bp, ENTRY_URL), 2.4, 4.8);
    await step(bp, PHASE.overlay, () => dismissOverlays(bp, 2), 0.8, 1.6);
    await step(bp, PHASE.entry, () => openUploadDialog(bp), 1.5, 3);

    log.verbose('该站需先上传媒体才会出现文案框，故媒体步骤先于编辑框步骤');
    await step(bp, PHASE.media, () => attachMedia(bp, {
      files: [video],
      fileInputXpaths: X.fileInput,
      acceptHint: 'video',
      readyProbeJs: locatePredicateJs(X.editor),
      readyTimeoutMs: 60000,
      label: '视频',
      hint: SITE_HINT,
    }), 2.4, 4.8);
    log.status('已选择视频文件，等待上传初始化');

    const boxes = await step(bp, PHASE.editor, () => waitFor(bp, locateAllJs(X.editor, 'data-opencli-yt-box'), 60000, '标题/描述输入框', SITE_HINT), 1.5, 3);
    log.status(`已定位输入框（${boxes.count} 个）`);

    if (content) {
      const title = content.length > TITLE_MAX ? content.slice(0, TITLE_MAX) + '...' : content;
      await step(bp, PHASE.text, async () => {
        await fillEditor(bp, boxes.selectors[0], title);
        if (boxes.count > 1) await fillEditor(bp, boxes.selectors[boxes.count - 1], content);
      }, 1.5, 3);
    }
    await step(bp, PHASE.settings, () => applySettings(bp), 1.5, 3);
    if (dryRun) {
      log.status('dry-run 完成，跳过发布按钮');
      return row('dry_run');
    }
    await step(bp, PHASE.publish, () => clickWhenReady(bp, X.publishBtn, 120000, '发布按钮', SITE_HINT), 1.5, 3);
    return publishFinish(bp, {
      probeJs: resultProbeJs({
        goneSelector: 'ytcp-uploads-dialog',
        urlPattern: 'watch\\?v=',
        texts: ['video published', '视频已发布', '已发布'],
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
  requireSingleVideo,
  X,
};
