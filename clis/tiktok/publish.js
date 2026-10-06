import { cli, Strategy } from '@jackwener/opencli/registry';
import { CommandExecutionError } from '@jackwener/opencli/errors';
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
  humanWait,
  gotoWithRetry,
  fillEditor,
  attachMedia,
  publishFinish,
  locateJs,
  waitFor,
  clickXpath,
  clickWhenReady,
  confirmDialog,
  dismissOverlays,
  resultProbeJs,
} from '../shared/publish-helpers.js';

const ENTRY_URL = 'https://www.tiktok.com/tiktokstudio/upload?from=webapp&tab=video';
const ID_PATTERN = /\/video\/(\d+)/;
const SITE_HINT = 'TikTok UI may have changed — re-check the studio upload semantic selectors';

const X = {
  panel: [
    '//*[@id="panel-video"]',
    '//*[@data-e2e="select_video_container"]',
  ],
  pasteTarget: [
    '//*[@data-e2e="select_video_container"]',
    '//*[@id="panel-video"]',
  ],
  mediaBtn: [
    '//*[@data-e2e="select_video_button"]',
    '//*[@id="panel-video"]//button',
  ],
  fileInput: [
    '//input[@type="file"][contains(@accept,"video")]',
    '//input[@type="file"]',
  ],
  editor: [
    '//*[@data-e2e="caption_container"]//div[@contenteditable="true"]',
    '//*[@data-e2e="caption_container"]//*[@contenteditable="true"]',
    '//div[@contenteditable="true"]',
  ],
  scheduleNow: [
    '//*[@data-e2e="schedule_container"]//label[1]',
    '//*[@data-e2e="schedule_container"]//*[@role="radio"][1]',
  ],
  visibilityTrigger: [
    '//*[@data-e2e="video_visibility_container"]//button',
  ],
  visibilityOption: [
    '//*[@role="listbox"]//*[@role="option"][1]',
    '//*[@role="menu"]//*[@role="menuitem"][1]',
  ],
  publishBtn: [
    '//*[@data-e2e="post_video_button"]',
  ],
};

const VIDEO_ATTACHED_PROBE = `(() => {
  let files = 0;
  for (const i of document.querySelectorAll('input[type="file"]')) files += (i.files ? i.files.length : 0);
  const blobVideo = !!document.querySelector('video[src^="blob:"], video[src^="data:"]');
  const txt = ((document.body && document.body.innerText) || '').toLowerCase();
  const progress = /uploading|upload progress|上传中|正在上传|processing|处理中|上传成功/.test(txt);
  return { ok: files > 0 || blobVideo || progress, files, blobVideo, progress };
})()`;

async function applySettings(bp) {
  if ((await clickXpath(bp, X.scheduleNow))?.ok) {
    log.status('· 已设置"何时发布"：立即');
    await humanWait(bp, 0.8, 1.6);
  } else {
    log.verbose('未找到"何时发布"选项，沿用默认（立即发布）');
  }
  if (!(await clickXpath(bp, X.visibilityTrigger))?.ok) {
    log.verbose('未找到"谁可以看"选项，沿用默认（公开）');
    return;
  }
  await humanWait(bp, 0.8, 1.6);
  if ((await clickXpath(bp, X.visibilityOption))?.ok) {
    log.status('· 已设置"谁可以看"：公开');
    await humanWait(bp, 0.8, 1.6);
    return;
  }
  await clickXpath(bp, X.visibilityTrigger);
  log.verbose('未找到"谁可以看"选项，收起下拉并沿用默认（公开）');
}

cli({
  site: 'tiktok',
  name: 'publish',
  access: 'write',
  description: 'Upload a video with a caption to TikTok',
  domain: 'www.tiktok.com',
  strategy: Strategy.UI,
  browser: true,
  siteSession: 'persistent',
  defaultWindowMode: 'foreground',
  args: buildArgs({ media: 'video', timeout: 300, requiredMedia: true }),
  columns: COLUMNS,
  func: async (page, kwargs) => {
    const bp = page;
    if (!bp) throw new CommandExecutionError('Browser session required for tiktok publish');
    await requireLogin(bp, 'https://www.tiktok.com', ['sessionid', 'sessionid_ss', 'sid_tt'], 'www.tiktok.com');
    log.status('已登录，开始整理发布内容');
    const content = resolveContent({ text: kwargs.text, file: kwargs.file });
    const { videos } = normalizeMediaFiles({ videos: kwargs.videos, maxVideos: 1, site: 'tiktok' });
    const video = videos[0];
    const timeout = Number(kwargs.timeout) || 300;
    const waitMs = Math.max(60000, Math.round(timeout * 1000 * 0.4));
    const dryRun = Boolean(kwargs['dry-run'] ?? kwargs.dryRun);
    log.status(`内容 ${content.length} 字，视频 1 个${dryRun ? '（dry-run）' : ''}`);

    await step(bp, PHASE.open, () => gotoWithRetry(bp, ENTRY_URL), 2.4, 4.8);
    await step(bp, PHASE.overlay, () => dismissOverlays(bp, 3), 0.8, 1.6);
    await step(bp, PHASE.entry, () => waitFor(bp, locateJs(X.panel, { mode: 'exists' }), 60000, '上传面板', SITE_HINT), 1.5, 3);

    log.verbose('该站需先上传媒体才会出现文案框，故媒体步骤先于编辑框步骤');
    const attached = await step(bp, PHASE.media, () => attachMedia(bp, {
      files: [video],
      pasteTargets: X.pasteTarget,
      fileInputXpaths: X.fileInput,
      selectFromComputer: X.mediaBtn,
      acceptHint: 'video',
      readyProbeJs: VIDEO_ATTACHED_PROBE,
      pasteTimeoutMs: 20000,
      readyTimeoutMs: 120000,
      label: '视频',
      hint: SITE_HINT,
    }), 2.4, 4.8);
    log.status(`视频已提交（方式：${attached.via === 'paste' ? '粘贴' : '文件输入'}），等待服务端处理`);

    const editor = await step(bp, PHASE.editor, async () => {
      await waitFor(bp, locateJs(X.editor, { mode: 'exists' }), waitMs, '文案框', SITE_HINT);
      const marked = await bp.evaluate(locateJs(X.editor, 'data-opencli-tt-editor'));
      if (!marked?.ok) throw new CommandExecutionError('TikTok caption box not found', SITE_HINT);
      return marked;
    }, 1.5, 3);

    if (content) {
      await clickXpath(bp, X.editor);
      await step(bp, PHASE.text, () => fillEditor(bp, editor.selector, content), 1.5, 3);
    }
    await step(bp, PHASE.settings, () => applySettings(bp), 0.8, 1.6);
    if (dryRun) {
      log.status('dry-run 完成，跳过发布按钮');
      return row('dry_run');
    }
    await step(bp, PHASE.publish, async () => {
      await dismissOverlays(bp, 2);
      await clickWhenReady(bp, X.publishBtn, 60000, '发布按钮', SITE_HINT);
    }, 1.5, 3);
    return publishFinish(bp, {
      probeJs: resultProbeJs({ urlPattern: '/video/\\d+', requireGone: false, base: 'https://www.tiktok.com' }),
      timeoutMs: waitMs,
      firstMs: 25000,
      hint: SITE_HINT,
      idPattern: ID_PATTERN,
      retry: () => confirmDialog(bp, { label: '发布确认弹窗', hint: SITE_HINT }),
    });
  },
});

export const __test__ = {
  resolveContent,
  normalizeMediaFiles,
  X,
};
