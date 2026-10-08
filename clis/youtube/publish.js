/**
 * YouTube publish — Playwright connectOverCDP。
 * 控件一律用 id / 组件名 / 固定顺序，不靠界面文案（语言会变）。
 * 观众：ytkc-made-for-kids-select 第 2 项 = 非儿童；公开范围：visibility 第 3 项 = Public。
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { CommandExecutionError } from '@jackwener/opencli/errors';
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
} from '../shared/pw-session.js';

const ENTRY_URL = 'https://studio.youtube.com';
const SITE_HINT = 'YouTube UI may have changed — re-check the upload dialog semantic selectors';

const X = {
  entry: ['//*[@id="upload-icon"]'],
  fileInput: ['//ytcp-uploads-dialog//input[@type="file"]', '//input[@type="file"]'],
  nextBtn: ['//*[@id="next-button"]'],
  publishBtn: ['//*[@id="done-button"]'],
  /** 0=Yes kids, 1=No kids */
  kidsNo: ['//ytkc-made-for-kids-select//tp-yt-paper-radio-button[2]'],
  /** 0=Private, 1=Unlisted, 2=Public */
  visibilityPublic: ['//ytcp-video-visibility-select//tp-yt-paper-radio-button[3]'],
};

/** @param {import('playwright-core').Locator} loc */
async function isEnabledLoc(loc) {
  if (!(await loc.isVisible().catch(() => false))) return false;
  if ((await loc.getAttribute('aria-disabled').catch(() => null)) === 'true') return false;
  if (await loc.evaluate((el) => el.hasAttribute('disabled')).catch(() => true)) return false;
  return true;
}

/** 等 #next-button 可点（观众题未答时会 disabled） */
async function waitNextEnabled(dialog, page, timeoutMs = 20000) {
  const next = dialog.locator('#next-button').first();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isEnabledLoc(next)) return next;
    await page.waitForTimeout(400);
  }
  return next;
}

async function assertNoUploadLimit(page) {
  const lim = await page.evaluate(() => {
    const root = document.querySelector('ytcp-uploads-dialog') || document.body;
    const t = String(root.innerText || root.textContent || '');
    const re = /已达到每日上传数上限|每日上传.{0,16}上限|daily upload limit|upload limit reached/i;
    const m = t.match(re);
    if (!m) return null;
    return t.slice(t.indexOf(m[0]), t.indexOf(m[0]) + 100).replace(/\s+/g, ' ').trim();
  });
  if (lim) {
    throw new CommandExecutionError(`YouTube 拒绝上传：${lim}`, SITE_HINT);
  }
}

/**
 * 真发成功判定（不靠正文「发布」文案）：
 * 1) 出现 ytcp-video-share-dialog（「视频发布时间 / 分享链接」）—— 点完 Publish 后的成功态
 * 2) 或 uploads-dialog / #done-button 都已消失
 * 上传对话框在分享层下面可能仍留在 DOM，不能只看 uploads-dialog。
 */
async function waitYouTubePublished(page, dialog, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const share = page.locator('ytcp-video-share-dialog').first();
    if (await share.isVisible().catch(() => false)) {
      log.status('· 已出现分享成功对话框');
      // 点关闭（最后一个/带 close 的 button），不靠文案
      let closeBtn = share.locator('#close-button').first();
      if (!(await closeBtn.isVisible().catch(() => false))) {
        closeBtn = share.locator('button').last();
      }
      if (await closeBtn.isVisible().catch(() => false)) {
        await closeBtn.click({ force: true }).catch(() => {});
        await page.waitForTimeout(500);
      }
      return true;
    }

    const uploadsGone = !(await page.locator('ytcp-uploads-dialog').first().isVisible().catch(() => false));
    const doneVisible = await page.evaluate(() => {
      const done = document.querySelector('ytcp-uploads-dialog #done-button');
      if (!done || done.hasAttribute('hidden')) return false;
      const r = done.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }).catch(() => false);

    if (uploadsGone && !doneVisible) return true;
    // 仅当仍停在公开范围（done 可见）才继续等；其它中间态也继续轮询
    await page.waitForTimeout(800);
  }

  const shareLeft = await page.locator('ytcp-video-share-dialog').isVisible().catch(() => false);
  if (shareLeft) return true;

  const stuckOnVisibility = await page.evaluate(() => {
    const done = document.querySelector('ytcp-uploads-dialog #done-button');
    if (!done || done.hasAttribute('hidden')) return false;
    const share = document.querySelector('ytcp-video-share-dialog');
    if (share) {
      const r = share.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return false;
    }
    const r = done.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }).catch(() => false);
  if (stuckOnVisibility) {
    throw new CommandExecutionError(
      'YouTube 仍停在公开范围（#done-button 可见），发布未真正点击成功',
      SITE_HINT,
    );
  }
  throw new CommandExecutionError('publish step timed out: 发布结果', SITE_HINT);
}

cli({
  site: 'youtube',
  name: 'publish',
  access: 'write',
  description: 'Upload a video to YouTube Studio (Playwright + CDP endpoint)',
  domain: 'studio.youtube.com',
  strategy: Strategy.UI,
  browser: false,
  args: buildArgs({ media: 'video', timeout: 600, requiredMedia: true }),
  columns: STATUS_COLUMNS,
  func: async (kwargs) => {
    const content = resolveContent({ text: kwargs.text, file: kwargs.file });
    const { videos } = normalizeMediaFiles({ videos: kwargs.videos, maxVideos: 1, site: 'youtube' });
    const video = videos[0];
    const timeout = Number(kwargs.timeout) || 600;
    const dryRun = Boolean(kwargs['dry-run'] ?? kwargs.dryRun);
    log.status(`内容 ${content.length} 字，视频 1 个${dryRun ? '（dry-run）' : ''}`);

    return runPublishSession({
      entryUrl: ENTRY_URL,
      fn: async ({ page, context }) => {
        await assertCookies(context, 'https://www.youtube.com', ['SID', 'HSID', 'SSID', 'LOGIN_INFO'], 'YouTube');
        log.status('已登录，开始整理发布内容');
        await humanWait(page, 0.8, 1.4);

        await step(page, PHASE.open, () => page.goto(ENTRY_URL, { waitUntil: 'domcontentloaded', timeout: 180000 }), 2.4, 4.0);

        await step(page, PHASE.entry, async () => {
          const upload = await firstVisible(page, ['#upload-icon', 'ytcp-icon-button#upload-icon'], 60000);
          if (!upload) throw new CommandExecutionError('上传入口 not found', SITE_HINT);
          await mouseClickLocator(page, upload);
          await humanWait(page, 1.0, 1.8);
          // 下拉项：优先 href，不用文案
          const menu = page.locator('a[href*="/upload"]').first();
          if (await menu.isVisible().catch(() => false)) {
            await mouseClickLocator(page, menu);
            await humanWait(page, 1.2, 2.0);
          }
        }, 1.5, 2.5);

        const dialog = page.locator('ytcp-uploads-dialog').first();
        await step(page, PHASE.media, async () => {
          await dialog.waitFor({ state: 'visible', timeout: 60000 }).catch(() => {});
          const input = page.locator('ytcp-uploads-dialog input[type="file"], input[type="file"]').first();
          if (await input.count()) {
            await input.setInputFiles(video);
          } else {
            const chooserP = page.waitForEvent('filechooser', { timeout: 30000 });
            // 无 file input 时点对话框内第一个可见 ytcp-button（选择文件）
            const pick = dialog.locator('#select-files-button, ytcp-button').first();
            await mouseClickLocator(page, pick);
            await (await chooserP).setFiles(video);
          }
          log.status('· 视频已选择');
          await page.locator('ytcp-uploads-dialog [role="textbox"]').first()
            .waitFor({ state: 'visible', timeout: 180000 });
          await assertNoUploadLimit(page);
        }, 2.4, 4.0);

        await step(page, PHASE.text, async () => {
          const boxes = dialog.locator('[role="textbox"]');
          const n = await boxes.count();
          if (n >= 1 && content) {
            const title = content.length > 90 ? `${content.slice(0, 90)}...` : content;
            await boxes.nth(0).click({ force: true });
            await page.keyboard.press('Control+a');
            await boxes.nth(0).fill(title);
          }
          if (n >= 2 && content) {
            await boxes.nth(1).click({ force: true });
            await boxes.nth(1).fill(content);
          }
          log.status(`· 已填入标题/描述`);
        }, 1.5, 2.8);

        await step(page, PHASE.settings, async () => {
          // 固定顺序：第 0=是儿童，第 1=非儿童（与语言无关）
          const kidsNo = dialog.locator('ytkc-made-for-kids-select tp-yt-paper-radio-button').nth(1);
          if (await kidsNo.isVisible().catch(() => false)) {
            await kidsNo.scrollIntoViewIfNeeded().catch(() => {});
            await mouseClickLocator(page, kidsNo).catch(() => kidsNo.click({ force: true }));
            log.status('· 已选非面向儿童（kids radio #2）');
            await humanWait(page, 0.8, 1.4);
          }

          const next = dialog.locator('#next-button').first();
          // 点 #next-button 推进到公开范围（最多 4 步）
          for (let i = 0; i < 4; i++) {
            const done = dialog.locator('#done-button').first();
            const doneHidden = await done.evaluate((el) => el.hasAttribute('hidden')).catch(() => true);
            if (!doneHidden && await done.isVisible().catch(() => false)) break;

            if (!(await isEnabledLoc(next))) {
              // next 仍 disabled：再点一次非儿童并等待启用
              if (await kidsNo.isVisible().catch(() => false)) {
                await kidsNo.click({ force: true }).catch(() => {});
                await humanWait(page, 0.5, 0.9);
              }
              await waitNextEnabled(dialog, page, 20000);
            }
            if (!(await isEnabledLoc(next))) break;

            await mouseClickLocator(page, next).catch(() => next.click({ force: true }));
            log.status(`· 已点 next #${i + 1}`);
            await humanWait(page, 1.5, 2.5);
          }

          // 固定顺序：0=Private 1=Unlisted 2=Public
          const vis = dialog.locator('ytcp-video-visibility-select tp-yt-paper-radio-button').nth(2);
          await vis.waitFor({ state: 'visible', timeout: 30000 });
          await vis.scrollIntoViewIfNeeded().catch(() => {});
          await mouseClickLocator(page, vis).catch(() => vis.click({ force: true }));
          await humanWait(page, 0.6, 1.0);
          log.status('· 已选公开（visibility radio #3）');
        }, 2.0, 3.5);

        const pub = await step(page, PHASE.publish, async () => {
          await assertNoUploadLimit(page);
          const btn = dialog.locator('#done-button').first();
          const next = dialog.locator('#next-button').first();
          // 等到 #done-button 非 hidden（公开范围步）
          const deadline = Date.now() + 90000;
          while (Date.now() < deadline) {
            const hidden = await btn.evaluate((el) => el.hasAttribute('hidden')).catch(() => true);
            if (!hidden && await btn.isVisible().catch(() => false)) break;
            if (await isEnabledLoc(next)) {
              await next.click({ force: true }).catch(() => {});
              await humanWait(page, 1.0, 1.6);
            } else {
              await page.waitForTimeout(500);
            }
          }
          await btn.waitFor({ state: 'visible', timeout: 15000 });
          const box = await btn.boundingBox().catch(() => null);
          log.status(`· 已定位 #done-button` + (box ? ` @${Math.round(box.x)},${Math.round(box.y)}` : ''));
          return { loc: btn, label: 'done' };
        }, 1.2, 2.0);

        if (dryRun) {
          log.status('dry-run：已定位 #done-button，跳过点击');
          return statusRow('dry_run');
        }

        // ytcp-button 内层 button 才吃点击；禁止用 Processing 等正文误判成功
        await pub.loc.scrollIntoViewIfNeeded();
        const inner = pub.loc.locator('button').first();
        if (await inner.count()) {
          await inner.click({ force: true });
        } else {
          await mouseClickLocator(page, pub.loc, '#done-button');
        }
        log.status('· 已点击 #done-button');
        await humanWait(page, 2.0, 3.5);

        await step(page, PHASE.result, () => waitYouTubePublished(page, dialog, Math.max(120000, timeout * 1000)), 1.0, 1.8);
        log.status('已发布');
        return statusRow('published');
      },
    });
  },
});

export const __test__ = { resolveContent, normalizeMediaFiles, X };
