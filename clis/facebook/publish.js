/**
 * Facebook publish — Playwright connectOverCDP。
 * 入口/发布按钮用结构位置与 role，不靠界面文案。
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, CommandExecutionError } from '@jackwener/opencli/errors';
import { log } from '@jackwener/opencli/logger';
import {
  STATUS_COLUMNS,
  PHASE,
  resolveContent,
  normalizeMediaFiles,
  buildArgs,
  statusRow,
} from '../shared/publish-helpers.js';
import {
  runPublishSession,
  assertCookies,
  humanWait,
  randomWait,
  step,
  mouseClickLocator,
} from '../shared/pw-session.js';

const ENTRY_URL = 'https://www.facebook.com/';
const MAX_MEDIA = 10;
const SITE_HINT = 'Facebook UI may have changed — re-check the composer semantic selectors';

const X = {
  entry: ['//*[@role="region"]//*[@role="button"]'],
  editor: ['//*[@role="dialog"]//*[@role="textbox"]'],
};

async function openComposer(page) {
  // Feed 顶部创作区：含 textbox 的 region 内第一个 button，或可点的 placeholder textbox
  const regionBtn = page.locator('[role="region"] [role="button"]').first();
  const feedBox = page.locator('[role="main"] [role="textbox"], [role="main"] [contenteditable="true"]').first();
  let entry = null;
  if (await regionBtn.isVisible({ timeout: 8000 }).catch(() => false)) entry = regionBtn;
  else if (await feedBox.isVisible({ timeout: 8000 }).catch(() => false)) entry = feedBox;
  if (!entry) {
    // 退路：页面上尚未进 dialog 的 textbox
    entry = page.locator('[role="textbox"]').first();
  }
  if (!(await entry.isVisible({ timeout: 60000 }).catch(() => false))) {
    throw new CommandExecutionError('发帖入口 not found', SITE_HINT);
  }
  log.status('· 点击发帖热区');
  await mouseClickLocator(page, entry);
  await humanWait(page, 1.5, 2.8);
  const dialog = page.locator('[role="dialog"]').filter({
    has: page.locator('[role="textbox"], [contenteditable="true"]'),
  }).first();
  await dialog.waitFor({ state: 'visible', timeout: 60000 });
  log.status('· 发帖对话框已打开');
  return dialog;
}

async function fillCaption(page, dialog, content) {
  const box = dialog.locator('[role="textbox"], [contenteditable="true"]').first();
  await box.waitFor({ state: 'visible', timeout: 30000 });
  await box.click({ force: true });
  await randomWait(page, 200, 400);
  try { await box.fill(content); } catch { await page.keyboard.insertText(content); }
  log.status(`· 已填入正文 ${content.length} 字`);
}

async function attachMedia(page, dialog, files) {
  const input = dialog.locator('input[type="file"]').first();
  if (await input.count()) {
    await input.setInputFiles(files);
  } else {
    const chooserP = page.waitForEvent('filechooser', { timeout: 30000 });
    // 无文案：dialog 内带 file 相关的 toolbar button — 取含 input[type=file] 的 label/父级旁 button
    const tool = dialog.locator('input[type="file"]').locator('xpath=ancestor::*[self::form or self::div][1]//*[self::div[@role="button"] or self::button]').first();
    if (await tool.count()) await mouseClickLocator(page, tool);
    else throw new CommandExecutionError('媒体入口 not found', SITE_HINT);
    await (await chooserP).setFiles(files);
  }
  await humanWait(page, 2.0, 3.5);
  log.status(`· 已附加 ${files.length} 个媒体`);
}

/** 结构定位：dialog 底部近满宽 button（排除表情等小图标） */
async function findPublishByGeometry(dialog, { allowDisabled = false } = {}) {
  const box = await dialog.boundingBox();
  if (!box) return null;
  const candidates = dialog.locator('[role="button"], button');
  const n = await candidates.count();
  const hits = [];
  for (let i = 0; i < n; i++) {
    const el = candidates.nth(i);
    if (!(await el.isVisible().catch(() => false))) continue;
    const disabled = (await el.getAttribute('aria-disabled')) === 'true'
      || await el.isDisabled().catch(() => false);
    if (disabled && !allowDisabled) continue;
    const r = await el.boundingBox();
    if (!r || r.height < 24) continue;
    if (r.y < box.y + box.height * 0.7) continue;
    if (r.width < box.width * 0.5) continue;
    hits.push({ loc: el, r });
  }
  if (!hits.length) return null;
  hits.sort((a, b) => (b.r.y + b.r.height) - (a.r.y + a.r.height) || b.r.width - a.r.width);
  return hits[0].loc;
}

/**
 * xpath fallback：发帖条常见为 dialog 内 aria-label 含 Post/发帖 的 role=button
 * （仅几何失败时使用）
 */
const PUBLISH_XPATH = [
  'xpath=.//*[@role="button" and (@aria-label="发帖" or @aria-label="Post" or @aria-label="Publish" or @aria-label="發佈")]',
  'xpath=.//*[@role="button"][.//span[normalize-space()="发帖" or normalize-space()="Post" or normalize-space()="Publish"]]',
];

async function isPublishEnabled(loc) {
  const aria = await loc.getAttribute('aria-disabled').catch(() => null);
  if (aria === 'true') return false;
  if (await loc.isDisabled().catch(() => false)) return false;
  // FB 有时用 class / 父级表示灰态
  const looksDisabled = await loc.evaluate((el) => {
    if (el.getAttribute('aria-disabled') === 'true') return true;
    const op = getComputedStyle(el).opacity;
    if (op && Number(op) < 0.6) return true;
    return false;
  }).catch(() => false);
  return !looksDisabled;
}

/**
 * 等发帖按钮可用再返回。媒体上传中常为 aria-disabled=true，此时 force-click 无效。
 */
async function findPublishButton(dialog, { allowDisabled = false, waitEnabledMs = 90000 } = {}) {
  const deadline = Date.now() + waitEnabledMs;
  let last = null;
  while (Date.now() < deadline) {
    let loc = await findPublishByGeometry(dialog, { allowDisabled: true });
    let how = 'geometry';
    if (!loc) {
      for (const xp of PUBLISH_XPATH) {
        const cand = dialog.locator(xp).first();
        if (await cand.isVisible().catch(() => false)) {
          loc = cand;
          how = 'xpath';
          break;
        }
      }
    }
    if (loc) {
      last = { loc, label: 'publish', how };
      const enabled = await isPublishEnabled(loc);
      if (allowDisabled || enabled) {
        if (!enabled) log.status('· 发帖按钮仍 disabled（dry-run 仍定位）');
        else log.status('· 发帖按钮已启用');
        return last;
      }
      log.status('· 发帖按钮 aria-disabled，等待媒体/校验完成…');
    }
    await dialog.page().waitForTimeout(600);
  }
  if (allowDisabled && last) return last;
  throw new CommandExecutionError(
    '发帖按钮一直不可用（aria-disabled）',
    'Wait for media upload to finish, then retry',
  );
}

/** 必须在按钮 enabled 时普通 click；禁用态 force-click 不会真发帖 */
async function clickPublish(page, loc) {
  await loc.scrollIntoViewIfNeeded().catch(() => {});
  // 再确认一次 enabled
  const enableDeadline = Date.now() + 30000;
  while (Date.now() < enableDeadline && !(await isPublishEnabled(loc))) {
    await page.waitForTimeout(500);
  }
  if (!(await isPublishEnabled(loc))) {
    throw new CommandExecutionError('发帖按钮仍为 disabled，拒绝点击', SITE_HINT);
  }
  await randomWait(page, 120, 280);
  // 测试脚本结论：普通 click（等 enabled）才能关掉 dialog；force 点 disabled 无效
  await loc.click({ timeout: 10000 });
  log.status('· 已 click 发帖按钮（enabled）');
}

cli({
  site: 'facebook',
  name: 'publish',
  access: 'write',
  description: 'Publish a text/image post to Facebook (Playwright + CDP endpoint)',
  domain: 'www.facebook.com',
  strategy: Strategy.UI,
  browser: false,
  args: buildArgs({ media: 'both', timeout: 180 }),
  columns: STATUS_COLUMNS,
  func: async (kwargs) => {
    const content = resolveContent({ text: kwargs.text, file: kwargs.file });
    const { images, videos } = normalizeMediaFiles({ images: kwargs.images, videos: kwargs.videos });
    const media = [...images, ...videos];
    if (media.length > MAX_MEDIA) throw new ArgumentError(`Too many media files: ${media.length}`);
    if (!content && media.length === 0) throw new ArgumentError('Provide --text/--file or --images/--videos');
    const timeout = Number(kwargs.timeout) || 180;
    const dryRun = Boolean(kwargs['dry-run'] ?? kwargs.dryRun);
    log.status(`内容 ${content.length} 字，媒体 ${media.length} 个${dryRun ? '（dry-run）' : ''}`);

    return runPublishSession({
      entryUrl: ENTRY_URL,
      fn: async ({ page, context }) => {
        await assertCookies(context, ENTRY_URL, ['c_user', 'xs'], 'Facebook');
        log.status('已登录，开始整理发布内容');
        await humanWait(page, 0.8, 1.4);

        await step(page, PHASE.open, () => page.goto(ENTRY_URL, { waitUntil: 'domcontentloaded', timeout: 180000 }), 2.4, 4.0);
        await step(page, PHASE.overlay, async () => {
          const dlg = page.locator('[role="dialog"]').first();
          if (await dlg.isVisible({ timeout: 600 }).catch(() => false)) {
            const btn = dlg.locator('button, [role="button"]').first();
            if (await btn.isVisible().catch(() => false)) await btn.click({ timeout: 1500 }).catch(() => {});
          }
        }, 0.8, 1.6);

        const dialog = await step(page, PHASE.entry, () => openComposer(page), 2.0, 3.5);
        await step(page, PHASE.editor, async () => {
          await dialog.locator('[role="textbox"], [contenteditable="true"]').first().waitFor({ state: 'visible', timeout: 30000 });
        }, 1.2, 2.0);

        if (content) await step(page, PHASE.text, () => fillCaption(page, dialog, content), 1.5, 2.8);
        if (media.length) await step(page, PHASE.media, () => attachMedia(page, dialog, media), 2.4, 4.0);

        const pub = await step(page, PHASE.publish, async () => {
          // 只关表情层：点一下 textbox 失焦，避免 Esc 误关整个发帖 dialog
          const tb = dialog.locator('[role="textbox"], [contenteditable="true"]').first();
          if (await tb.isVisible().catch(() => false)) await tb.click({ force: true }).catch(() => {});
          await randomWait(page, 200, 400);
          const btn = await findPublishButton(dialog, { allowDisabled: dryRun });
          if (!btn) throw new CommandExecutionError('发布按钮 not found', SITE_HINT);
          const box = await btn.loc.boundingBox().catch(() => null);
          log.status(`· 已定位发帖按钮（${btn.how}）` + (box ? ` @${Math.round(box.x)},${Math.round(box.y)} ${Math.round(box.width)}×${Math.round(box.height)}` : ''));
          return btn;
        }, 1.2, 2.0);

        if (dryRun) {
          log.status('dry-run：已定位发布按钮，跳过点击');
          return statusRow('dry_run');
        }
        await clickPublish(page, pub.loc);
        await humanWait(page, 2.5, 4.0);
        await step(page, PHASE.result, async () => {
          // 成功：创建帖子 dialog 关闭（不靠正文）
          const waitGone = async (ms) => {
            const deadline = Date.now() + ms;
            while (Date.now() < deadline) {
              if (!(await dialog.isVisible().catch(() => false))) return true;
              await page.waitForTimeout(600);
            }
            return false;
          };
          if (await waitGone(Math.min(timeout * 1000, 45000))) return true;
          // 仍开着：xpath 再点一次
          log.status('· 对话框仍在，xpath 再点发帖…');
          for (const xp of PUBLISH_XPATH) {
            const loc = dialog.locator(xp).first();
            if (await loc.isVisible().catch(() => false)) {
              await clickPublish(page, loc);
              await humanWait(page, 2.0, 3.5);
              break;
            }
          }
          if (await waitGone(30000)) return true;
          throw new CommandExecutionError('Facebook 发帖对话框未关闭，发布可能未生效', SITE_HINT);
        }, 1.0, 1.8);
        log.status('已发布');
        return statusRow('published');
      },
    });
  },
});

export const __test__ = { resolveContent, normalizeMediaFiles, X };
