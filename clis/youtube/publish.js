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
  waitFor,
  gotoWithRetry,
  attachMedia,
  publishFinish,
  locateJs,
  clickXpath,
  clickWhenReady,
  dismissOverlays,
  resultProbeJs,
} from '../shared/publish-helpers.js';

const ENTRY_URL = 'https://studio.youtube.com';
// 标题超出上限时自动截断并在尾部补 '...'：YouTube 标题上限 100，故正文留 97 个字。
const TITLE_MAX = 97;
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
  closeBtn: [
    '//ytcp-uploads-still-processing-dialog//*[@id="close-button"]',
    '//tp-yt-paper-dialog//*[@id="close-button"]',
    '//tp-yt-paper-dialog//*[@id="close-icon-button"]',
  ],
  kidsNo: [
    '//ytkc-made-for-kids-select//tp-yt-paper-radio-button[2]',
  ],
  visibilityPublic: [
    '//ytcp-video-visibility-select//tp-yt-paper-radio-button[3]',
  ],
};

const DIALOG_PROBE = `(() => ({ ok: !!document.querySelector('ytcp-uploads-dialog') }))()`;

// 上传对话框内的字数超限检查。上限由字段自身决定（页面计数 used/max），CLI 不写死任何限制：
// 扫描对话框内形如 "used/max" 的叶子计数文本，used > max 即超限；字段名从祖先节点的
// 稳定 id（#title-textarea / #description-textarea）判定，语言无关。
const OVER_LIMIT_PROBE = `(() => {
  const vis = el => { const st = getComputedStyle(el); const r = el.getBoundingClientRect(); return st.display !== 'none' && st.visibility !== 'hidden' && r.width > 0 && r.height > 0; };
  const dlg = document.querySelector('ytcp-uploads-dialog');
  if (!dlg) return { ok: true };
  const out = [];
  const seen = new Set();
  for (const el of dlg.querySelectorAll('*')) {
    if (!vis(el) || el.childElementCount > 0) continue;
    const t = (el.textContent || '').trim();
    const m = t.match(/^(\\d[\\d,]*)\\s*\\/\\s*(\\d[\\d,]*)$/);
    if (!m) continue;
    const used = Number(m[1].replace(/,/g, ''));
    const max = Number(m[2].replace(/,/g, ''));
    if (!(used > max)) continue;
    let field = '';
    for (let p = el; p && p !== dlg; p = p.parentElement) {
      const pid = p.id || '';
      if (/title/i.test(pid)) { field = 'title'; break; }
      if (/description/i.test(pid)) { field = 'description'; break; }
    }
    const key = field + ':' + used + '/' + max;
    if (!seen.has(key)) { seen.add(key); out.push({ field, used, max, over: used - max }); }
  }
  return out.length ? { ok: false, fields: out } : { ok: true };
})()`;

// 视频刚上传完时 Studio 会重新抢焦点，此时 Ctrl+A / insertText 可能整批丢失（实测偶发：
// 同一段流程有时写入失败、重试即成功），所以清空与写入都按「做完就校验、不成功再来」
// 的方式做，最多 3 轮。
async function clearTextbox(bp, selector) {
  await bp.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (e instanceof HTMLElement) e.focus(); })()`);
  await bp.cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', modifiers: 2, windowsVirtualKeyCode: 65 });
  await bp.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', modifiers: 2, windowsVirtualKeyCode: 65 });
  await bp.cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Delete', windowsVirtualKeyCode: 46 });
  await bp.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Delete', windowsVirtualKeyCode: 46 });
}

// 站点内自包含的填写：清空 → insertText 一次 → 规范化校验（忽略空白/换行差异）。
// 不用共享 fillEditor：它对 contenteditable 用 innerText 严格相等校验，Studio 标题框
// 会吞掉 \n、innerText 对 <br> 也有规范化差异 → 校验误判失败 → 内部二次插入 → 内容翻倍
// （历史 bug：标题 184/100 = 92×2）。
async function fillTextbox(bp, selector, text) {
  const sel = JSON.stringify(selector);
  const focusJs = `(() => { const e = document.querySelector(${sel}); if (e instanceof HTMLElement) e.focus(); })()`;
  const readJs = `(() => { const e = document.querySelector(${sel}); return e instanceof HTMLElement ? String(e.innerText || '') : null; })()`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    await clearTextbox(bp, selector);
    await bp.wait({ time: 0.3 });
    await bp.evaluate(focusJs);
    await bp.insertText(text);
    await bp.wait({ time: 0.5 });
    const got = await bp.evaluate(readJs);
    if (got != null && got.replace(/\s+/g, '') === text.replace(/\s+/g, '')) return;
    log.verbose(`第 ${attempt} 次写入未生效，重试`);
    await bp.wait({ time: 0.6 });
  }
  await throwUploadLimit(bp, `标题/描述未能写入输入框（${selector}）`);
}

const POST_DIALOG_PROBE = `(() => {
  for (const x of ${JSON.stringify(X.closeBtn)}) {
    const el = document.evaluate(x, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
    if (!(el instanceof Element)) continue;
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return { ok: true };
  }
  return { ok: false };
})()`;

async function closePostPublishDialogs(bp, rounds = 3) {
  for (let i = 1; i <= rounds; i++) {
    try {
      await waitFor(bp, POST_DIALOG_PROBE, 10000, '发布后弹窗', SITE_HINT);
    } catch {
      log.verbose('未出现发布后弹窗（或已全部关闭），无需处理');
      return;
    }
    await clickWhenReady(bp, X.closeBtn, 15000, '关闭按钮', SITE_HINT);
    log.status(`· 已关闭发布后弹窗（第 ${i} 个）`);
    await humanWait(bp, 1.2, 2.4);
  }
}

async function openUploadDialog(bp) {
  // 每日上传次数达到上限时，入口点了也弹不出对话框/菜单，先识别这种状态给出明确报错。
  // 只在「该出现的没出现」的失败路径里查页面文案，不影响正常流程。
  const pre = await uploadLimitError(bp);
  if (pre) throw pre;
  await clickWhenReady(bp, X.entry, 30000, '上传入口', SITE_HINT);
  try {
    await waitFor(bp, DIALOG_PROBE, 20000, '上传对话框', SITE_HINT);
    return;
  } catch {
    log.verbose('入口未直接打开对话框，尝试点击上传菜单项');
  }
  try {
    await clickWhenReady(bp, X.menuItem, 15000, '上传视频菜单项', SITE_HINT);
    await waitFor(bp, DIALOG_PROBE, 30000, '上传对话框', SITE_HINT);
  } catch (err) {
    const le = await uploadLimitError(bp);
    if (le) throw le;
    throw err;
  }
}

// 页面文案里找「每日/上传上限」相关提示（中英文都覆盖），命中返回明确错误对象。
// 只在失败路径调用，不影响正常流程。
const UPLOAD_LIMIT_PROBE = `(() => {
  const t = String(document.body?.innerText || '');
  const m = t.match(/[^\\n]{0,60}(daily upload limit|uploads? limit|上传次数.{0,12}上限|每日上传|达到.{0,8}上限)[^\\n]{0,60}/i);
  return m ? { ok: true, text: m[0].trim().slice(0, 140) } : { ok: false };
})()`;

async function uploadLimitError(bp) {
  const lim = await bp.evaluate(UPLOAD_LIMIT_PROBE).catch(() => null);
  if (!lim?.ok) return null;
  return new CommandExecutionError(
    `YouTube 拒绝上传：页面提示「${lim.text}」（可能已达到每日上传次数上限，次日重置后再试）`,
    'Daily upload limits reset at midnight Pacific Time (UTC-8)',
  );
}

async function throwUploadLimit(bp, fallbackMessage) {
  const le = await uploadLimitError(bp);
  if (le) throw le;
  throw new CommandExecutionError(fallbackMessage, SITE_HINT);
}

async function applySettings(bp) {
  const kids = await clickXpath(bp, X.kidsNo);
  log.status(kids?.ok ? '· 已设置"非儿童内容"' : '· 未找到儿童内容选项，跳过');
  for (let i = 1; i <= 3; i++) {
    if ((await bp.evaluate(DIALOG_PROBE)) && (await bp.evaluate(`(() => ({ ok: !!document.querySelector('ytcp-video-visibility-select') }))()`))?.ok) break;
    try {
      await clickWhenReady(bp, X.nextBtn, 30000, `继续（第 ${i} 步）`, SITE_HINT);
      log.status(`· 已点击继续（第 ${i} 步）`);
      await humanWait(bp, 1.5, 3);
    } catch { break; }
  }
  const pub = await clickXpath(bp, X.visibilityPublic);
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
    const { videos } = normalizeMediaFiles({ videos: kwargs.videos, maxVideos: 1, site: 'youtube' });
    const video = videos[0];
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
      readyProbeJs: locateJs(X.editor, { mode: 'exists' }),
      readyTimeoutMs: 60000,
      label: '视频',
      hint: SITE_HINT,
    }), 2.4, 4.8);
    log.status('已选择视频文件，等待上传初始化');

    const boxes = await step(bp, PHASE.editor, () => waitFor(bp, locateJs(X.editor, { mode: 'all', attrPrefix: 'data-opencli-yt-box' }), 60000, '标题/描述输入框', SITE_HINT), 1.5, 3);
    log.status(`已定位输入框（${boxes.count} 个）`);

    if (content) {
      const truncated = content.length > TITLE_MAX;
      const title = truncated ? content.slice(0, TITLE_MAX) + '...' : content;
      if (truncated) log.status(`标题 ${content.length} 字超出上限，已截断为 ${title.length} 字（尾部补 ...）`);
      await step(bp, PHASE.text, async () => {
        await fillTextbox(bp, boxes.selectors[0], title);
        if (boxes.count > 1) await fillTextbox(bp, boxes.selectors[boxes.count - 1], content);
        await humanWait(bp, 0.6, 1.2);
        const st = await bp.evaluate(OVER_LIMIT_PROBE).catch(() => ({ ok: true }));
        if (!st.ok) {
          const f = st.fields[0];
          const name = f.field === 'title' ? '标题' : f.field === 'description' ? '描述' : (f.field || '字段');
          throw new CommandExecutionError(
            `YouTube 拒绝继续：${name}超出字符限制（页面计数 ${f.used}/${f.max}，超出 ${f.over} 字），请精简后重试`,
            'The limit is shown by the page counter — shorten the text or check the account plan',
          );
        }
      }, 1.5, 3);
    }
    await step(bp, PHASE.settings, () => applySettings(bp), 1.5, 3);
    if (dryRun) {
      log.status('dry-run 完成，跳过发布按钮');
      return row('dry_run');
    }
    await step(bp, PHASE.publish, () => clickWhenReady(bp, X.publishBtn, 120000, '发布按钮', SITE_HINT), 1.5, 3);
    const out = await publishFinish(bp, {
      probeJs: resultProbeJs({
        goneSelector: 'ytcp-uploads-dialog',
        urlPattern: 'watch\\?v=',
        texts: ['video published', '视频已发布', '已发布'],
      }),
      timeoutMs: timeout * 1000,
      hint: SITE_HINT,
      idPattern: ID_PATTERN,
    });
    await step(bp, '· 关闭发布后弹窗', () => closePostPublishDialogs(bp), 1.2, 2.4);
    return out;
  },
});

export const __test__ = {
  resolveContent,
  normalizeMediaFiles,
  X,
};
