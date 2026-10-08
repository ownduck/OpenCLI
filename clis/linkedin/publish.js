/**
 * LinkedIn publish — Playwright connectOverCDP。
 * Shadow DOM 弹层；限流检测；仅 status。
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, CommandExecutionError } from '@jackwener/opencli/errors';
import { log } from '@jackwener/opencli/logger';
import * as fs from 'node:fs';
import * as path from 'node:path';
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
} from '../shared/pw-session.js';

const ENTRY_URL = 'https://www.linkedin.com/feed/';
const MAX_MEDIA = 9;
const SITE_HINT = 'LinkedIn UI may have changed — re-check the feed composer semantic selectors';

const X = {
  entry: ['//a[contains(@href,"/preload/sharebox")]'],
  editor: ['//*[@role="dialog"]//*[@role="textbox"]', '//*[@role="dialog"]//div[contains(@class,"ql-editor")]'],
};

async function openComposer(page) {
  // 稳定 href，不靠 aria-label 文案
  const target = await firstVisible(page, [
    'a[href*="/preload/sharebox"]',
    'button.share-box-feed-entry__trigger',
    '.share-box-feed-entry__trigger',
  ], 60000);
  if (!target) throw new CommandExecutionError('发动态热区 not found', SITE_HINT);
  log.status('· 点击发动态热区');
  await mouseClickLocator(page, target);
  await humanWait(page, 2.0, 3.5);

  const dialog = page.locator('[role="dialog"].share-box-v2__modal, .share-box-v2__modal, [role="dialog"]').first();
  await dialog.waitFor({ state: 'visible', timeout: 60000 });
  const editor = dialog.locator('[role="textbox"], .ql-editor, [contenteditable="true"]').first();
  await editor.waitFor({ state: 'visible', timeout: 30000 });
  log.status('· 发帖框已打开');
  return { dialog, editor };
}

async function pasteImages(page, editor, files) {
  for (const filePath of files) {
    const abs = path.resolve(filePath);
    const b64 = fs.readFileSync(abs).toString('base64');
    const ext = path.extname(abs).toLowerCase();
    const mime = ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' })[ext] || 'application/octet-stream';
    const name = path.basename(abs);
    await editor.click({ force: true });
    await editor.evaluate((el, { b64, mime, name }) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const file = new File([bytes], name, { type: mime });
      const dt = new DataTransfer();
      dt.items.add(file);
      el.focus();
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }, { b64, mime, name });
    await humanWait(page, 1.2, 2.0);
  }
  // 媒体编辑器：点 primary，不靠「完成/Done」文案
  for (let i = 0; i < files.length + 2; i++) {
    const next = page.locator('[class*="media-editor"] button.artdeco-button--primary').first();
    if (!(await next.isVisible().catch(() => false))) break;
    await mouseClickLocator(page, next).catch(() => {});
    await humanWait(page, 1.5, 2.5);
  }
  log.status(`· 已附加 ${files.length} 个图片`);
}

async function findPublishButton(dialog) {
  // 固定 class：share-actions__primary-action
  const primary = dialog.locator('button.share-actions__primary-action').first();
  if (await primary.isVisible().catch(() => false)) {
    return { loc: primary, label: 'primary' };
  }
  const fallback = dialog.locator('.share-actions button.artdeco-button--primary, footer button.artdeco-button--primary').first();
  if (await fallback.isVisible().catch(() => false)) {
    return { loc: fallback, label: 'primary' };
  }
  return null;
}

async function assertNotRateLimited(page) {
  const t = (await page.evaluate(() => {
    const parts = [document.body?.innerText || ''];
    for (const el of document.querySelectorAll('[role="dialog"], .artdeco-modal, .share-box-v2__modal')) {
      parts.push(el.innerText || '');
    }
    // open shadow
    for (const host of document.querySelectorAll('*')) {
      if (host.shadowRoot) parts.push(host.shadowRoot.textContent || '');
    }
    return parts.join('\n');
  }).catch(() => '')).toLowerCase();
  const keys = ['上限', '立即验证', '已达', '验证身份', 'too many', 'daily limit', 'limit reached', 'temporarily restricted'];
  const hit = keys.filter((k) => t.includes(k)).join(' / ');
  if (hit) throw new CommandExecutionError('LinkedIn 发布被限流', `页面提示：${hit}`);
}

cli({
  site: 'linkedin',
  name: 'publish',
  access: 'write',
  description: 'Publish a text/image post to LinkedIn (Playwright + CDP endpoint)',
  domain: 'www.linkedin.com',
  strategy: Strategy.UI,
  browser: false,
  args: buildArgs({ media: 'image', timeout: 180 }),
  columns: STATUS_COLUMNS,
  func: async (kwargs) => {
    const content = resolveContent({ text: kwargs.text, file: kwargs.file });
    const { images } = normalizeMediaFiles({ images: kwargs.images });
    if (images.length > MAX_MEDIA) throw new ArgumentError(`Too many images: ${images.length}`);
    if (!content && images.length === 0) throw new ArgumentError('Provide --text/--file or --images');
    const timeout = Number(kwargs.timeout) || 180;
    const dryRun = Boolean(kwargs['dry-run'] ?? kwargs.dryRun);
    log.status(`内容 ${content.length} 字，图片 ${images.length} 个${dryRun ? '（dry-run）' : ''}`);

    return runPublishSession({
      entryUrl: ENTRY_URL,
      fn: async ({ page, context }) => {
        await assertCookies(context, 'https://www.linkedin.com', ['li_at'], 'LinkedIn');
        log.status('已登录，开始整理发布内容');
        await humanWait(page, 0.8, 1.4);

        await step(page, PHASE.open, () => page.goto(ENTRY_URL, { waitUntil: 'domcontentloaded', timeout: 180000 }), 2.4, 4.0);
        await step(page, PHASE.overlay, async () => { /* feed 遮罩较少 */ }, 0.4, 0.8);

        const { dialog, editor } = await step(page, PHASE.entry, () => openComposer(page), 1.5, 2.8);
        await editor.evaluate((el) => el.setAttribute('data-opencli-li-editor', '1'));

        if (content) {
          await step(page, PHASE.text, async () => {
            await editor.click({ force: true });
            await randomWait(page, 200, 400);
            try { await editor.fill(content); } catch { await page.keyboard.insertText(content); }
            log.status(`· 已填入正文 ${content.length} 字`);
          }, 1.5, 2.8);
        }
        if (images.length) {
          await step(page, PHASE.media, () => pasteImages(page, editor, images), 2.4, 4.5);
        }

        const pub = await step(page, PHASE.publish, async () => {
          const btn = await findPublishButton(dialog);
          if (!btn) throw new CommandExecutionError('发布按钮 not found', SITE_HINT);
          const box = await btn.loc.boundingBox().catch(() => null);
          log.status(`· 已定位发布热区「${btn.label}」` + (box ? ` @${Math.round(box.x)},${Math.round(box.y)}` : ''));
          return btn;
        }, 1.2, 2.0);

        if (dryRun) {
          log.status(`dry-run：已定位发布按钮（${pub.label}），跳过点击`);
          return statusRow('dry_run');
        }

        await mouseClickLocator(page, pub.loc);
        await humanWait(page, 2.0, 3.5);
        await step(page, PHASE.result, async () => {
          const deadline = Date.now() + Math.min(90000, Math.max(30000, timeout * 1000));
          while (Date.now() < deadline) {
            await assertNotRateLimited(page);
            const gone = !(await page.locator('.share-box-v2__modal, [role="dialog"]').first().isVisible().catch(() => false));
            if (gone) return;
            await page.waitForTimeout(700);
          }
          await assertNotRateLimited(page);
          throw new CommandExecutionError('publish step timed out: 发布结果', SITE_HINT);
        }, 0.5, 1.0);
        log.status('已发布');
        return statusRow('published');
      },
    });
  },
});

export const __test__ = { resolveContent, normalizeMediaFiles, X };
