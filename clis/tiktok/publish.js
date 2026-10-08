/**
 * TikTok publish — Playwright connectOverCDP。
 * 控件用 data-e2e / role / 按钮顺序，不靠界面文案（语言会变）。
 * 弹窗约定：左次要 / 右主操作 → 确认 Discard、Post now 均点 dialog 内最后一个 button。
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

const WARMUP_URL = 'https://www.tiktok.com/';
const ENTRY_URL = 'https://www.tiktok.com/tiktokstudio/upload?from=webapp&tab=video';
const SITE_HINT = 'TikTok UI may have changed — re-check the studio upload semantic selectors';

/** 可见的 role=dialog（不按文案筛） */
function anyDialog(page) {
  return page.locator('[role="dialog"]').filter({ has: page.locator('button') }).first();
}

/** dialog 内第 index 个可见 button（0=左次要，-1/last=右主操作） */
async function dialogButton(dialog, index) {
  const btns = dialog.locator('button');
  const n = await btns.count();
  if (!n) return null;
  const i = index < 0 ? n + index : index;
  if (i < 0 || i >= n) return null;
  const btn = btns.nth(i);
  if (!(await btn.isVisible().catch(() => false))) return null;
  return btn;
}

/** 关闭 Discard 确认：点 dialog 最后一个 button（粉色 Discard） */
async function confirmDiscardPost(page, { waitMs = 4000 } = {}) {
  const confirm = anyDialog(page);
  if (!(await confirm.isVisible({ timeout: waitMs }).catch(() => false))) return false;
  // 上传页此时不应再点到底部 discard_post_button；确认框内 last = Discard
  const btn = await dialogButton(confirm, -1);
  if (!btn) return false;
  const box = await btn.boundingBox().catch(() => null);
  log.status(`· 关闭 Discard 确认框` + (box ? ` @${Math.round(box.x)},${Math.round(box.y)}` : ''));
  await btn.click({ force: true });
  await confirm.waitFor({ state: 'hidden', timeout: 15000 }).catch(() => {});
  if (await confirm.isVisible().catch(() => false)) {
    await mouseClickLocator(page, btn).catch(() => {});
    await confirm.waitFor({ state: 'hidden', timeout: 10000 }).catch(() => {});
  }
  if (await confirm.isVisible().catch(() => false)) {
    throw new CommandExecutionError('Discard 确认框未能关闭', SITE_HINT);
  }
  return true;
}

/** 顶栏草稿：local_draft_container 内第一个 button = Discard */
async function clickDraftBannerDiscard(page) {
  const draft = page.locator('[data-e2e="local_draft_container"]');
  if (!(await draft.isVisible().catch(() => false))) return false;
  const btn = draft.locator('button').first();
  if (!(await btn.isVisible().catch(() => false))) return false;
  await btn.click({ force: true });
  return true;
}

async function dismissDraftModal(page) {
  const draft = page.locator('[data-e2e="local_draft_container"]');
  if (await confirmDiscardPost(page, { waitMs: 1500 })) {
    log.status('· 已确认丢弃草稿');
  }
  if (!(await draft.isVisible().catch(() => false))) return;

  if (await clickDraftBannerDiscard(page)) {
    await randomWait(page, 400, 800);
    await confirmDiscardPost(page, { waitMs: 5000 });
  }
  await draft.waitFor({ state: 'hidden', timeout: 15000 }).catch(() => {});
  if (await draft.isVisible().catch(() => false) || await anyDialog(page).isVisible().catch(() => false)) {
    throw new CommandExecutionError('未保存草稿未能丢弃', SITE_HINT);
  }
  log.status('· 已丢弃未保存草稿');
}

async function ensureDiscardClosed(page, {
  settleSec = 1.5,
  pollMs = 6000,
  label = '下一步',
} = {}) {
  log.status(`· 等待 ${settleSec}s 后检查 Discard 确认框…`);
  await humanWait(page, settleSec, settleSec);
  const deadline = Date.now() + pollMs;
  let closed = false;
  while (Date.now() < deadline) {
    if (await confirmDiscardPost(page, { waitMs: 600 })) {
      closed = true;
      break;
    }
    if (await clickDraftBannerDiscard(page)) {
      await randomWait(page, 500, 900);
      if (await confirmDiscardPost(page, { waitMs: 5000 })) closed = true;
      break;
    }
    await page.waitForTimeout(400);
  }
  if (await confirmDiscardPost(page, { waitMs: 1500 })) closed = true;
  if (closed) log.status(`· Discard 确认框已关闭，继续${label}`);
  else log.status(`· 未出现 Discard 确认框，继续${label}`);
}

/**
 * Checks 未完成 → Continue to post：点 dialog 最后一个 button（Post now）。
 */
async function confirmContinueToPost(page, { waitMs = 5000 } = {}) {
  const dialog = anyDialog(page);
  if (!(await dialog.isVisible({ timeout: waitMs }).catch(() => false))) return false;
  const postNow = await dialogButton(dialog, -1);
  if (!postNow) return false;
  const box = await postNow.boundingBox().catch(() => null);
  log.status(`· 确认发布弹窗主按钮` + (box ? ` @${Math.round(box.x)},${Math.round(box.y)}` : ''));
  await postNow.click({ force: true });
  await dialog.waitFor({ state: 'hidden', timeout: 15000 }).catch(() => {});
  if (await dialog.isVisible().catch(() => false)) {
    await mouseClickLocator(page, postNow).catch(() => {});
    await dialog.waitFor({ state: 'hidden', timeout: 10000 }).catch(() => {});
  }
  if (await dialog.isVisible().catch(() => false)) {
    throw new CommandExecutionError('发布确认框未能关闭', SITE_HINT);
  }
  return true;
}

/** 误出 Discard 时点第一个 button（Not now）保住草稿 */
async function dismissDiscardKeepDraft(page) {
  const dialog = anyDialog(page);
  if (!(await dialog.isVisible().catch(() => false))) return false;
  const notNow = await dialogButton(dialog, 0);
  if (notNow) await notNow.click({ force: true }).catch(() => {});
  return true;
}

async function waitTikTokPublished(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const url = page.url();
    if (/tiktokstudio/i.test(url) && !/\/upload/i.test(url)) return true;

    const postVisible = await page.locator('[data-e2e="post_video_button"]').first().isVisible().catch(() => false);
    const captionVisible = await page.locator('[data-e2e="caption_container"]').first().isVisible().catch(() => false);
    if (!postVisible && !captionVisible && !/\/upload/i.test(url)) return true;

    await confirmContinueToPost(page, { waitMs: 800 });

    // 仍停在 upload 且弹出 dialog：若刚点完 Post 却像 Discard，点左按钮保住内容并报错
    if (/\/upload/i.test(url) && postVisible && await anyDialog(page).isVisible().catch(() => false)) {
      // 再试一次主按钮（Continue to post）
      const again = await confirmContinueToPost(page, { waitMs: 500 });
      if (!again && await anyDialog(page).isVisible().catch(() => false)) {
        await dismissDiscardKeepDraft(page);
        throw new CommandExecutionError(
          '发布过程中确认框未按预期关闭',
          SITE_HINT,
        );
      }
    }
    await page.waitForTimeout(800);
  }
  throw new CommandExecutionError('publish step timed out: 发布结果', SITE_HINT);
}

/** 何时发布：schedule_container 第一个 label = Now */
async function setWhenToPostNow(page) {
  const box = page.locator('[data-e2e="schedule_container"]');
  if (!(await box.isVisible().catch(() => false))) return;
  const target = box.locator('label').first();
  if (await target.isVisible().catch(() => false)) {
    await mouseClickLocator(page, target).catch(() => target.click({ force: true }));
    log.status('· 已设置何时发布：立即（schedule label #1）');
  }
}

/** 谁可以看：打开 combobox，选 listbox 第一个 option = Everyone */
async function setVisibilityEveryone(page) {
  const box = page.locator('[data-e2e="video_visibility_container"]');
  if (!(await box.isVisible().catch(() => false))) return;
  const combo = box.locator('button[role="combobox"], button').first();
  await mouseClickLocator(page, combo);
  await randomWait(page, 300, 600);
  const opt = page.locator('[role="listbox"] [role="option"], [role="option"]').first();
  if (await opt.isVisible().catch(() => false)) {
    await mouseClickLocator(page, opt);
    log.status('· 已设置谁可以看：Everyone（option #1）');
  } else {
    await page.keyboard.press('Escape').catch(() => {});
    log.status('· 未展开可见性选项，保持当前');
  }
}

const X = {
  fileInput: ['//input[@type="file"]'],
  editor: ['//*[@data-e2e="caption_container"]//*[@contenteditable="true"]'],
  publishBtn: ['//*[@data-e2e="post_video_button"]'],
  visibility: ['//*[@data-e2e="video_visibility_container"]'],
};

cli({
  site: 'tiktok',
  name: 'publish',
  access: 'write',
  description: 'Upload a video with a caption to TikTok (Playwright + CDP endpoint)',
  domain: 'www.tiktok.com',
  strategy: Strategy.UI,
  browser: false,
  args: buildArgs({ media: 'video', timeout: 300, requiredMedia: true }),
  columns: STATUS_COLUMNS,
  func: async (kwargs) => {
    const content = resolveContent({ text: kwargs.text, file: kwargs.file });
    const { videos } = normalizeMediaFiles({ videos: kwargs.videos, maxVideos: 1, site: 'tiktok' });
    const video = videos[0];
    const timeout = Number(kwargs.timeout) || 300;
    const dryRun = Boolean(kwargs['dry-run'] ?? kwargs.dryRun);
    log.status(`内容 ${content.length} 字，视频 1 个${dryRun ? '（dry-run）' : ''}`);

    return runPublishSession({
      entryUrl: ENTRY_URL,
      fn: async ({ page, context }) => {
        await assertCookies(context, 'https://www.tiktok.com', ['sessionid', 'sessionid_ss', 'sid_tt'], 'TikTok');
        log.status('已登录，开始整理发布内容');
        await humanWait(page, 0.8, 1.4);

        await step(page, PHASE.open, async () => {
          await page.goto(WARMUP_URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
          await humanWait(page, 1.5, 2.5);
          await page.goto(ENTRY_URL, { waitUntil: 'domcontentloaded', timeout: 180000 });
        }, 2.4, 4.0);

        await step(page, PHASE.entry, async () => {
          await dismissDraftModal(page);
          const panel = await firstVisible(page, ['#panel-video', '[data-e2e="select_video_container"]'], 90000);
          if (!panel) throw new CommandExecutionError('上传面板 not found', SITE_HINT);
        }, 1.5, 2.5);

        await ensureDiscardClosed(page, { settleSec: 1.5, pollMs: 6000, label: '附加媒体' });

        await step(page, PHASE.media, async () => {
          const chooserP = page.waitForEvent('filechooser', { timeout: 30000 }).catch(() => null);
          const btn = page.locator('[data-e2e="select_video_button"]').first();
          if (await btn.isVisible().catch(() => false)) {
            await mouseClickLocator(page, btn);
            const chooser = await chooserP;
            if (chooser) await chooser.setFiles(video);
            else await page.locator('input[type="file"]').first().setInputFiles(video);
          } else {
            const input = page.locator('input[type="file"]').first();
            if (!(await input.count())) throw new CommandExecutionError('选择视频按钮/文件框 not found', SITE_HINT);
            await input.setInputFiles(video);
          }
          await page.locator('[data-e2e="caption_container"] [contenteditable="true"], video, [data-e2e="upload_status_container"]').first()
            .waitFor({ state: 'visible', timeout: 120000 });
          log.status('· 视频已提交');
          // 上传后偶发提示 dialog：点主按钮关掉
          await confirmContinueToPost(page, { waitMs: 1200 }).catch(() => {});
        }, 2.4, 4.0);

        const caption = page.locator('[data-e2e="caption_container"] [contenteditable="true"]').first();
        await step(page, PHASE.editor, () => caption.waitFor({ state: 'visible', timeout: Math.max(60000, timeout * 400) }), 1.5, 2.5);

        if (content) {
          await step(page, PHASE.text, async () => {
            await caption.click({ force: true });
            await page.keyboard.press('Control+a');
            await randomWait(page, 100, 250);
            try { await caption.fill(content); } catch { await page.keyboard.insertText(content); }
            log.status(`· 已填入正文 ${content.length} 字`);
          }, 1.5, 2.8);
        }

        await step(page, PHASE.settings, async () => {
          await setWhenToPostNow(page);
          await randomWait(page, 300, 600);
          await setVisibilityEveryone(page);
        }, 0.8, 1.6);

        const pub = await step(page, PHASE.publish, async () => {
          const btn = page.locator('[data-e2e="post_video_button"]').first();
          await btn.waitFor({ state: 'visible', timeout: 60000 });
          await btn.scrollIntoViewIfNeeded();
          await randomWait(page, 200, 400);
          const disc = page.locator('[data-e2e="discard_post_button"]').first();
          const [pb, db] = await Promise.all([btn.boundingBox(), disc.boundingBox().catch(() => null)]);
          if (pb && db && Math.abs(pb.x - db.x) < 4 && Math.abs(pb.y - db.y) < 4) {
            throw new CommandExecutionError('Post/Discard 热区重叠，拒绝点击', SITE_HINT);
          }
          log.status(`· 已定位 #post_video_button` + (pb ? ` @${Math.round(pb.x)},${Math.round(pb.y)}` : ''));
          return { loc: btn, label: 'post' };
        }, 1.2, 2.0);

        if (dryRun) {
          log.status('dry-run：已定位发布按钮，跳过点击');
          return statusRow('dry_run');
        }

        await ensureDiscardClosed(page, { settleSec: 0.8, pollMs: 3000, label: '点击 Post' });

        await pub.loc.scrollIntoViewIfNeeded();
        await mouseClickLocator(page, pub.loc, 'Post');
        await humanWait(page, 1.0, 1.8);
        await confirmContinueToPost(page, { waitMs: 6000 });
        await humanWait(page, 1.5, 2.5);
        await step(page, PHASE.result, () => waitTikTokPublished(page, Math.max(90000, timeout * 1000)), 1.0, 1.8);
        log.status('已发布');
        return statusRow('published');
      },
    });
  },
});

export const __test__ = { resolveContent, normalizeMediaFiles, X };
