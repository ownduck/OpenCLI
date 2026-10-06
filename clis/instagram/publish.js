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
  humanWait,
  waitFor,
  gotoWithRetry,
  fillEditor,
  attachMedia,
  uploadProbeJs,
  publishFinish,
  locateJs,
  clickXpath,
  clickWhenReady,
  clickPopupFirstItem,
  dismissOverlays,
  headerActionJs,
  resultProbeJs,
} from '../shared/publish-helpers.js';

const ENTRY_URL = 'https://www.instagram.com/';
const MAX_MEDIA = 10;
const ACTION_ATTR = 'data-opencli-ig-action';
const ID_PATTERN = /\/p\/([^/?#]+)/;
const SITE_HINT = 'Instagram UI may have changed — re-check the create dialog semantic selectors';

const X = {
  entry: [
    '//a[contains(@href, "/create/")]',
    '//*[@role="link"][contains(@href, "/create/")]',
    '//*[@aria-label="New post" or @aria-label="新帖子" or @aria-label="建立" or @aria-label="Crear" or @aria-label="Créer" or @aria-label="投稿" or @aria-label="Beitrag" or @aria-label="Новая публикация" or @aria-label="منشور"]',
  ],
  mediaBtn: [
    '//*[@role="dialog"]//button',
  ],
  fileInput: [
    '//*[@role="dialog"]//input[@type="file"]',
    '//input[@type="file"]',
  ],
  editor: [
    '//*[@role="dialog"]//div[@role="textbox"]',
    '//*[@role="dialog"]//div[@aria-label][@contenteditable="true"]',
    '//*[@role="dialog"]//div[@contenteditable="true"]',
  ],
};

const UPLOAD_ERRORS = [
  "couldn't be uploaded", 'could not be uploaded', 'too small', 'too large', 'too many',
  "isn't supported", 'not supported', '无法上传', '不支持', '文件过小',
];

const DIALOG_PROBE = `(() => ({ ok: !!document.querySelector('[role="dialog"]') }))()`;

async function clickHeaderAction(bp) {
  const marked = await waitFor(bp, headerActionJs(ACTION_ATTR), 45000, '对话框顶部按钮', SITE_HINT);
  const clicked = await clickXpath(bp, [`//*[@${ACTION_ATTR}="1"]`]);
  await bp.wait({ time: 0.3 });
  log.verbose(`对话框顶部按钮：<${marked.tag}> "${marked.label}"`);
  return Boolean(clicked?.ok);
}

async function openCreateDialog(bp) {
  await clickWhenReady(bp, X.entry, 60000, '创建入口', SITE_HINT, { preferMouse: true });
  if ((await bp.evaluate(DIALOG_PROBE))?.ok) return;
  try {
    await clickPopupFirstItem(bp, X.entry, { label: '创建菜单', hint: SITE_HINT });
  } catch (e) {
    log.verbose(`未出现创建菜单（${e?.message || e}），继续等待创建对话框`);
  }
  await waitFor(bp, DIALOG_PROBE, 45000, '创建对话框', SITE_HINT);
}

async function advanceToCaption(bp) {
  let editor = await bp.evaluate(locateJs(X.editor, 'data-opencli-ig-editor'));
  for (let i = 1; i <= 3 && !editor?.ok; i++) {
    let ok = false;
    try { ok = await clickHeaderAction(bp); } catch { ok = false; }
    if (!ok) break;
    log.status(`· 已点击继续（第 ${i} 步）`);
    await humanWait(bp, 5.3, 6.8);
    editor = await bp.evaluate(locateJs(X.editor, 'data-opencli-ig-editor'));
  }
  if (!editor?.ok) editor = await waitFor(bp, locateJs(X.editor, 'data-opencli-ig-editor'), 45000, '文案框', SITE_HINT);
  return editor;
}

async function closeSharedDialog(bp) {
  const attr = `${ACTION_ATTR}-done`;
  try {
    const marked = await waitFor(bp, headerActionJs(attr), 12000, '发布成功弹窗', SITE_HINT);
    const clicked = await clickXpath(bp, [`//*[@${attr}="1"]`]);
    log.verbose(`已关闭发布成功弹窗：<${marked.tag}> "${marked.label}"`);
    return Boolean(clicked?.ok);
  } catch {
    log.verbose('未出现发布成功弹窗（或已自动关闭），无需处理');
    return false;
  }
}

cli({
  site: 'instagram',
  name: 'publish',
  access: 'write',
  description: 'Publish an image post with a caption to Instagram',
  domain: 'www.instagram.com',
  strategy: Strategy.UI,
  browser: true,
  siteSession: 'persistent',
  defaultWindowMode: 'foreground',
  args: buildArgs({ media: 'image', timeout: 240, requiredMedia: true }),
  columns: COLUMNS,
  func: async (page, kwargs) => {
    const bp = page;
    if (!bp) throw new CommandExecutionError('Browser session required for instagram publish');
    await requireLogin(bp, ENTRY_URL, ['sessionid'], 'www.instagram.com');
    log.status('已登录，开始整理发布内容');
    const content = resolveContent({ text: kwargs.text, file: kwargs.file });
    const { images } = normalizeMediaFiles({ images: kwargs.images });
    if (images.length === 0) throw new ArgumentError('instagram publish requires at least one image', 'Pass --images <path> (jpg/png/webp)');
    if (images.length > MAX_MEDIA) throw new ArgumentError(`Too many images: ${images.length} (max ${MAX_MEDIA})`);
    const timeout = Number(kwargs.timeout) || 240;
    const dryRun = Boolean(kwargs['dry-run'] ?? kwargs.dryRun);
    log.status(`内容 ${content.length} 字，图片 ${images.length} 个${dryRun ? '（dry-run）' : ''}`);

    await step(bp, PHASE.open, () => gotoWithRetry(bp, ENTRY_URL), 2.4, 4.8);
    await step(bp, PHASE.overlay, () => dismissOverlays(bp, 2), 0.8, 1.6);
    await step(bp, PHASE.entry, () => openCreateDialog(bp), 1.2, 2.4);

    log.verbose('该站需先上传媒体才会出现文案框，故媒体步骤先于编辑框步骤');
    await step(bp, PHASE.media, () => attachMedia(bp, {
      files: images,
      fileInputXpaths: X.fileInput,
      selectFromComputer: X.mediaBtn,
      acceptHint: 'image',
      readyProbeJs: uploadProbeJs(images.length, [], UPLOAD_ERRORS),
      readyTimeoutMs: 90000,
      label: '图片',
      hint: SITE_HINT,
    }), 2.4, 4.8);
    log.status(`已上传 ${images.length} 个图片`);

    const editor = await step(bp, PHASE.editor, () => advanceToCaption(bp), 1.5, 3);
    if (content) {
      if (!editor?.ok) throw new CommandExecutionError('Instagram caption box not found', SITE_HINT);
      await clickXpath(bp, X.editor);
      await step(bp, PHASE.text, () => fillEditor(bp, editor.selector, content), 1.5, 3);
    }
    await step(bp, PHASE.settings, async () => { log.verbose('Instagram 无发布前设置，跳过'); }, 0.2, 0.4);
    if (dryRun) {
      log.status('dry-run 完成，跳过分享按钮');
      return row('dry_run');
    }
    await step(bp, PHASE.publish, () => clickHeaderAction(bp), 1.5, 3);
    const out = await publishFinish(bp, {
      probeJs: resultProbeJs({
        goneSelector: '[role="dialog"]',
        urlPattern: '/p/',
        texts: ['已分享', 'post shared', 'your post has been shared'],
        base: 'https://www.instagram.com',
      }),
      timeoutMs: Math.max(60000, timeout * 1000),
      hint: SITE_HINT,
      idPattern: ID_PATTERN,
      retry: () => clickHeaderAction(bp),
    });
    await step(bp, '· 关闭发布成功弹窗', () => closeSharedDialog(bp), 1.2, 2.4);
    return out;
  },
});

export const __test__ = {
  resolveContent,
  normalizeMediaFiles,
  X,
};
