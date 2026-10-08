/**
 * Instagram publish — Playwright connectOverCDP。
 * 入口/推进/分享优先用 href、dialog 顶栏右侧按钮位置，不靠界面文案。
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
  firstVisible,
  mouseClickLocator,
  waitPublishDone,
} from '../shared/pw-session.js';

const ENTRY_URL = 'https://www.instagram.com/';
const MAX_MEDIA = 10;
const SITE_HINT = 'Instagram UI may have changed — re-check the create dialog semantic selectors';

const X = {
  entry: ['//a[contains(@href, "/create/")]'],
  editor: ['//*[@role="dialog"]//div[@role="textbox"]', '//*[@role="dialog"]//div[@contenteditable="true"]'],
};

const CAPTION_LOCATORS = [
  '[role="dialog"] [role="textbox"]',
  '[role="dialog"] [contenteditable="true"]',
  '[role="dialog"] textarea',
];

/** dialog 顶栏右侧可见按钮（Next / Share 都在右上） */
async function dialogHeaderRightButton(dialog) {
  const box = await dialog.boundingBox();
  if (!box) return null;
  const candidates = dialog.locator('[role="button"], button');
  const n = await candidates.count();
  let best = null;
  for (let i = 0; i < n; i++) {
    const el = candidates.nth(i);
    if (!(await el.isVisible().catch(() => false))) continue;
    const r = await el.boundingBox().catch(() => null);
    if (!r) continue;
    // 顶栏：上半 28% 内、偏右
    if (r.y > box.y + box.height * 0.28) continue;
    if (r.x + r.width < box.x + box.width * 0.45) continue;
    if (!best || r.x > best.r.x) best = { loc: el, r };
  }
  return best;
}

async function openCreateDialog(page) {
  // 优先稳定 href，不靠 aria-label 文案
  const target = await firstVisible(page, ['a[href*="/create/"]'], 90000);
  if (!target) throw new CommandExecutionError('创建入口 not found', SITE_HINT);
  log.status('· 点击创建入口（/create/）');
  await mouseClickLocator(page, target);
  await humanWait(page, 1.5, 2.8);

  // 菜单若出现：点带 /create/ 的项
  const menuLink = page.locator('[role="dialog"] a[href*="/create/"], [role="menu"] a[href*="/create/"]').first();
  if (await menuLink.isVisible({ timeout: 4000 }).catch(() => false)) {
    log.status('· 点击创建菜单项');
    await mouseClickLocator(page, menuLink);
    await humanWait(page, 1.8, 3.2);
  }

  const dialog = page.locator('[role="dialog"]').first();
  await dialog.waitFor({ state: 'visible', timeout: 90000 });
  log.status('· 创建对话框已打开');
  return dialog;
}

async function uploadImages(page, dialog, images) {
  const fileInput = dialog.locator('input[type="file"]').first();
  if (await fileInput.count()) {
    await fileInput.setInputFiles(images);
  } else {
    const chooserPromise = page.waitForEvent('filechooser', { timeout: 60000 });
    // 无文案：优先 file input 旁第一个 button
    const chooseBtn = dialog.locator('button').first();
    await mouseClickLocator(page, chooseBtn);
    await (await chooserPromise).setFiles(images);
  }
  log.status(`· 已选择 ${images.length} 个图片`);
}

async function advanceToCaption(page, dialog) {
  for (let i = 1; i <= 4; i++) {
    const caption = await firstVisible(page, CAPTION_LOCATORS, 2500);
    if (caption) return caption;
    const next = await dialogHeaderRightButton(dialog);
    if (!next) break;
    log.status(`· 已点顶栏右侧继续（第 ${i} 步）`);
    await mouseClickLocator(page, next.loc);
    await humanWait(page, 2.4, 4.0);
  }
  const caption = await firstVisible(page, CAPTION_LOCATORS, 45000);
  if (!caption) throw new CommandExecutionError('Instagram caption box not found', SITE_HINT);
  return caption;
}

async function findShareButton(page, dialog) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    // 到 caption 步后，顶栏右侧即 Share
    const caption = await firstVisible(page, CAPTION_LOCATORS, 800);
    if (caption) {
      const share = await dialogHeaderRightButton(dialog);
      if (share) return { loc: share.loc, label: 'share' };
    }
    await page.waitForTimeout(400);
  }
  return null;
}

cli({
  site: 'instagram',
  name: 'publish',
  access: 'write',
  description: 'Publish an image post with a caption to Instagram (Playwright + CDP endpoint)',
  domain: 'www.instagram.com',
  strategy: Strategy.UI,
  browser: false,
  args: buildArgs({ media: 'image', timeout: 240, requiredMedia: true }),
  columns: STATUS_COLUMNS,
  func: async (kwargs) => {
    const content = resolveContent({ text: kwargs.text, file: kwargs.file });
    const { images } = normalizeMediaFiles({ images: kwargs.images });
    if (images.length === 0) throw new ArgumentError('instagram publish requires at least one image', 'Pass --images <path>');
    if (images.length > MAX_MEDIA) throw new ArgumentError(`Too many images: ${images.length} (max ${MAX_MEDIA})`);
    const timeout = Number(kwargs.timeout) || 240;
    const dryRun = Boolean(kwargs['dry-run'] ?? kwargs.dryRun);
    log.status(`内容 ${content.length} 字，图片 ${images.length} 个${dryRun ? '（dry-run）' : ''}`);

    return runPublishSession({
      entryUrl: ENTRY_URL,
      fn: async ({ page, context }) => {
        await assertCookies(context, ENTRY_URL, ['sessionid'], 'Instagram');
        log.status('已登录，开始整理发布内容');
        await humanWait(page, 0.8, 1.4);

        await step(page, PHASE.open, () => page.goto(ENTRY_URL, { waitUntil: 'domcontentloaded', timeout: 180000 }), 2.4, 4.0);
        await step(page, PHASE.overlay, async () => {
          // Cookie/通知：点页面上第一个可见 dialog 的次要或主按钮（不靠文案）
          const dlg = page.locator('[role="dialog"]').first();
          if (await dlg.isVisible({ timeout: 800 }).catch(() => false)) {
            const btn = dlg.locator('button').first();
            if (await btn.isVisible().catch(() => false)) await btn.click({ timeout: 2000 }).catch(() => {});
          }
        }, 0.8, 1.6);

        const dialog = await step(page, PHASE.entry, () => openCreateDialog(page), 1.5, 2.8);
        await step(page, PHASE.media, () => uploadImages(page, dialog, images), 2.4, 4.0);
        log.status(`已上传 ${images.length} 个图片`);
        const caption = await step(page, PHASE.editor, () => advanceToCaption(page, dialog), 1.5, 2.8);
        if (content) {
          await step(page, PHASE.text, async () => {
            await caption.click({ force: true });
            await randomWait(page, 200, 450);
            try { await caption.fill(content); } catch { await page.keyboard.insertText(content); }
            log.status(`· 已填入正文 ${content.length} 字`);
          }, 1.5, 2.8);
        }
        await step(page, PHASE.settings, async () => { log.verbose('Instagram 无发布前设置，跳过'); }, 0.3, 0.6);

        const share = await step(page, PHASE.publish, async () => {
          const btn = await findShareButton(page, dialog);
          if (!btn) throw new CommandExecutionError('分享按钮 not found', SITE_HINT);
          const box = await btn.loc.boundingBox().catch(() => null);
          log.status(`· 已定位分享热区` + (box ? ` @${Math.round(box.x)},${Math.round(box.y)}` : ''));
          return btn;
        }, 1.2, 2.0);

        if (dryRun) {
          log.status('dry-run：已定位发布按钮，跳过点击');
          return statusRow('dry_run');
        }
        await mouseClickLocator(page, share.loc);
        await humanWait(page, 2.8, 4.5);
        await step(page, PHASE.result, () => waitPublishDone(page, {
          timeoutMs: Math.max(60000, timeout * 1000),
          goneSel: '[role="dialog"]',
        }), 1.0, 1.8);
        log.status('已发布');
        return statusRow('published');
      },
    });
  },
});

export const __test__ = { resolveContent, normalizeMediaFiles, X };
