/**
 * Twitter/X publish — Playwright connectOverCDP。
 * 仅 status；超限时抛错并保留标签。
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
  waitPublishDone,
} from '../shared/pw-session.js';

const ENTRY_URL = 'https://x.com/compose/post';
const MAX_MEDIA = 4;
const SITE_HINT = 'X/Twitter UI may have changed — re-check the composer semantic selectors';

const X = {
  editor: ['//*[@data-testid="tweetTextarea_0"]', '//div[@role="textbox"]'],
  fileInput: ['//*[@data-testid="fileInput"]'],
  publishBtn: ['//*[@data-testid="tweetButton"]', '//*[@data-testid="tweetButtonInline"]'],
};

async function assertPostable(page) {
  const info = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('[data-testid="tweetButton"], [data-testid="tweetButtonInline"]')];
    if (!btns.length) return { ok: true };
    const enabled = btns.some((b) => b.disabled !== true && b.getAttribute('aria-disabled') !== 'true');
    if (enabled) return { ok: true };
    const t = document.querySelector('[data-testid="countdown-circle"]')?.innerText
      || document.querySelector('[data-testid="countdown-circle"]')?.textContent || '';
    const m = t.match(/exceeded the character limit by\s*([\d,]+)/i)
      || t.match(/超出[^\d]*([\d,]+)\s*字/)
      || t.match(/[-−–—－]\s*([\d,]+)/);
    const over = m ? Number(String(m[1]).replace(/,/g, '')) : null;
    return { ok: false, over: Number.isFinite(over) ? over : null, t: t.slice(0, 80) };
  });
  if (!info.ok) {
    const detail = info.over != null ? `超出 ${info.over} 字` : (info.t || 'Post 按钮不可用');
    throw new CommandExecutionError(`Twitter 无法发布：${detail}`, SITE_HINT);
  }
}

async function waitMediaPreview(page, n, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await page.evaluate((need) => {
      const attachments = document.querySelector('[data-testid="attachments"]');
      const preview = Math.max(
        attachments ? attachments.querySelectorAll('[role="group"], img, video').length : 0,
        document.querySelectorAll('[data-testid="tweetPhoto"], img[src^="blob:"]').length,
      );
      return preview >= need;
    }, n);
    if (ok) return;
    await page.waitForTimeout(400);
  }
  throw new CommandExecutionError('媒体预览未出现', SITE_HINT);
}

cli({
  site: 'twitter',
  name: 'publish',
  access: 'write',
  description: 'Publish a text/image post to X/Twitter (Playwright + CDP endpoint)',
  domain: 'x.com',
  strategy: Strategy.UI,
  browser: false,
  args: buildArgs({ media: 'image', timeout: 180 }),
  columns: STATUS_COLUMNS,
  func: async (kwargs) => {
    const content = resolveContent({ text: kwargs.text, file: kwargs.file });
    const { images } = normalizeMediaFiles({ images: kwargs.images });
    if (images.length > MAX_MEDIA) throw new ArgumentError(`Too many images: ${images.length} (max ${MAX_MEDIA})`);
    if (!content && images.length === 0) throw new ArgumentError('Provide --text/--file or --images');
    const timeout = Number(kwargs.timeout) || 180;
    const dryRun = Boolean(kwargs['dry-run'] ?? kwargs.dryRun);
    log.status(`内容 ${content.length} 字，图片 ${images.length} 个${dryRun ? '（dry-run）' : ''}`);

    return runPublishSession({
      entryUrl: ENTRY_URL,
      fn: async ({ page, context }) => {
        await assertCookies(context, 'https://x.com', ['auth_token', 'ct0'], 'Twitter/X');
        log.status('已登录，开始整理发布内容');
        await humanWait(page, 0.8, 1.4);

        await step(page, PHASE.open, () => page.goto(ENTRY_URL, { waitUntil: 'domcontentloaded', timeout: 180000 }), 2.4, 4.0);

        const editor = page.locator('[data-testid="tweetTextarea_0"], [role="textbox"]').first();
        await step(page, PHASE.editor, () => editor.waitFor({ state: 'visible', timeout: 45000 }), 1.5, 2.5);

        // 先文后图
        if (content) {
          await step(page, PHASE.text, async () => {
            await editor.click({ force: true });
            await randomWait(page, 150, 350);
            try { await editor.fill(content); } catch { await page.keyboard.insertText(content); }
            log.status(`· 已填入正文 ${content.length} 字`);
          }, 1.5, 2.8);
        }
        if (images.length) {
          await step(page, PHASE.media, async () => {
            const input = page.locator('[data-testid="fileInput"], input[type="file"]').first();
            await input.setInputFiles(images);
            await waitMediaPreview(page, images.length);
            log.status(`· 已附加 ${images.length} 个图片`);
          }, 2.4, 4.0);
        }

        const pub = await step(page, PHASE.publish, async () => {
          // dry-run 也要看得到按钮；超限时按钮可能灰，仍定位
          const btn = page.locator('[data-testid="tweetButton"], [data-testid="tweetButtonInline"]').first();
          await btn.waitFor({ state: 'visible', timeout: 30000 });
          const label = ((await btn.innerText().catch(() => '')) || 'Post').replace(/\s+/g, ' ').trim();
          const box = await btn.boundingBox().catch(() => null);
          log.status(`· 已定位发布热区「${label}」` + (box ? ` @${Math.round(box.x)},${Math.round(box.y)}` : ''));
          return { loc: btn, label };
        }, 1.2, 2.0);

        if (dryRun) {
          log.status(`dry-run：已定位发布按钮（${pub.label}），跳过点击`);
          return statusRow('dry_run');
        }

        await assertPostable(page);
        await mouseClickLocator(page, pub.loc);
        await humanWait(page, 2.5, 4.0);
        await step(page, PHASE.result, () => waitPublishDone(page, {
          timeoutMs: Math.max(45000, timeout * 1000),
          // 成功：composer 消失（不靠 toast 文案）
          goneSel: '[data-testid="tweetTextarea_0"]',
        }), 1.0, 1.8);
        log.status('已发布');
        return statusRow('published');
      },
    });
  },
});

export const __test__ = { resolveContent, normalizeMediaFiles, X };
