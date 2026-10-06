import * as fs from 'node:fs';
import * as path from 'node:path';
import { ArgumentError, AuthRequiredError, CommandExecutionError } from '@jackwener/opencli/errors';
import { log } from '@jackwener/opencli/logger';

// 受支持的媒体扩展名集合，classifyMedia 据此判定 image / video / unsupported
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp']);
const VIDEO_EXT = new Set(['.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v']);

// 六站 publish 统一的输出列（顺序固定，便于横向对比与测试断言）
export const COLUMNS = ['status', 'url', 'post_id'];

// 返回 isVisible 的页面脚本源码，供其它页面脚本拼接复用（尺寸>0 且未被 display/visibility 隐藏）
function isVisibleFn() {
  return `const isVisible = (el) => {
    if (!(el instanceof Element)) return false;
    const s = getComputedStyle(el); const r = el.getBoundingClientRect();
    return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
  };`;
}

// 注入页面的通用工具集：isVisible 可见性 / isDisabled 禁用态 / clickable 解析真正该点的元素 /
// byXpath|allByXpath 单查与全查 / byXpaths 按 xpath 顺序取首个（requireVisible 时优先可见、否则回退非禁用项）
const IN_PAGE_HELPERS = `${isVisibleFn()}
  const norm = (el) => ((el.textContent || '') + ' ' + (el.getAttribute && el.getAttribute('aria-label') || '')).replace(/\\s+/g, ' ').trim().toLowerCase();
  const isDisabled = (el) => el.disabled === true || (el.getAttribute && el.getAttribute('aria-disabled')) === 'true';
  const clickable = (el) => {
    if (el.tagName === 'BUTTON' || el.tagName === 'A') return el;
    const inner = el.querySelector('button, a');
    if (inner) return inner;
    const up = el.closest && el.closest('a, button, [role="button"]');
    return up || el;
  };
  const byXpath = (x, root) => { try { const r = document.evaluate(x, root || document, null, 9, null); return (r && r.singleNodeValue) || null; } catch (e) { return null; } };
  const allByXpath = (x, root) => { const out = []; try { const r = document.evaluate(x, root || document, null, 7, null); for (let i = 0; i < r.snapshotLength; i++) { const n = r.snapshotItem(i); if (n) out.push(n); } } catch (e) {} return out; };
  const byXpaths = (xs, root, skipDisabled, requireVisible) => {
    let fallback = null;
    for (const x of xs) {
      for (const el of allByXpath(x, root)) {
        if (!(el instanceof Element)) continue;
        if (skipDisabled && (isDisabled(el) || isDisabled(clickable(el)))) continue;
        if (!requireVisible || isVisible(el)) return el;
        if (!fallback) fallback = el;
      }
    }
    return requireVisible ? fallback : null;
  };`;

// 生成页面脚本：按顺序试 xpath，命中可见元素后打标记属性，返回 { ok, selector }；selector 可直接交给 clickXpath
export function locateJs(xpaths, attr) {
  return `(() => {
    ${IN_PAGE_HELPERS}
    const el = byXpaths(${JSON.stringify(xpaths)}, document, false, true);
    if (!(el instanceof HTMLElement)) return { ok: false };
    el.setAttribute(${JSON.stringify(attr)}, '1');
    return { ok: true, selector: '[${attr}="1"]' };
  })()`;
}

// 生成页面脚本：命中一组同类元素并逐一打标记（attr-0/1/2...），用于批量点击（如 YouTube 的单选项组）
export function locateAllJs(xpaths, attrPrefix) {
  return `(() => {
    ${IN_PAGE_HELPERS}
    let nodes = [];
    for (const x of ${JSON.stringify(xpaths)}) { nodes = allByXpath(x); if (nodes.length) break; }
    const els = nodes.filter(el => el instanceof HTMLElement);
    if (!els.length) return { ok: false };
    const selectors = [];
    els.forEach((el, i) => { const a = ${JSON.stringify(attrPrefix)} + '-' + i; el.setAttribute(a, '1'); selectors.push('[' + a + '="1"]'); });
    return { ok: true, count: els.length, selectors };
  })()`;
}

// 生成页面脚本：只判断元素是否存在（不点击），通常配合 waitFor 做「等待出现」
export function locatePredicateJs(xpaths, skipDisabled = true) {
  return `(() => {
    ${IN_PAGE_HELPERS}
    const el = byXpaths(${JSON.stringify(xpaths)}, document, ${skipDisabled}, true);
    return { ok: !!(el instanceof Element) };
  })()`;
}

// 生成页面脚本：在页面内直接 el.click()；React 受控的原生 button/a 只认这种方式（CDP 鼠标实测被忽略）
export function clickJs(xpaths, skipDisabled = true) {
  return `(() => {
    ${IN_PAGE_HELPERS}
    const el = byXpaths(${JSON.stringify(xpaths)}, document, ${skipDisabled}, true);
    if (!(el instanceof HTMLElement)) return { ok: false };
    clickable(el).click();
    return { ok: true };
  })()`;
}

// 生成页面脚本：给待点击元素打标记，并返回其标签名与尺寸，供 clickXpath 决定点击通道
function markJs(xpaths, attr, skipDisabled = true) {
  return `(() => {
    ${IN_PAGE_HELPERS}
    const prev = document.querySelectorAll('[${attr}]');
    for (const p of prev) p.removeAttribute('${attr}');
    const el = byXpaths(${JSON.stringify(xpaths)}, document, ${skipDisabled}, true);
    if (!(el instanceof Element)) return { ok: false };
    const target = clickable(el);
    target.setAttribute('${attr}', '1');
    const r = target.getBoundingClientRect();
    return { ok: true, tag: target.tagName.toLowerCase(), rect: { w: r.width, h: r.height } };
  })()`;
}

// 统一点击入口：打标记 → 自动滚动到视口 → 按元素类型选通道。
// 原生 button/a 走 DOM click，自定义元素（div[role=button]、Polymer）必须走 CDP 真实鼠标（preferMouse 可强制后者）
export async function clickXpath(page, xpaths, opts = {}) {
  const o = typeof opts === 'boolean' ? { skipDisabled: opts } : (opts || {});
  const skipDisabled = o.skipDisabled !== false;
  const marked = await page.evaluate(markJs(xpaths, 'data-opencli-click', skipDisabled));
  if (!marked?.ok) {
    log.verbose(`click: 未找到可点击元素 ${JSON.stringify(xpaths)}`);
    return { ok: false };
  }
  if (!o.preferMouse && (marked.tag === 'button' || marked.tag === 'a')) {
    await page.evaluate(clickJs(xpaths, skipDisabled));
    log.verbose(`click: <${marked.tag}> via dom`);
    return { ok: true, via: 'dom' };
  }
  if (page.cdp) {
    try {
      await page.cdp('DOM.enable');
      const doc = await page.cdp('DOM.getDocument', { depth: -1 });
      const q = await page.cdp('DOM.querySelector', { nodeId: doc?.root?.nodeId || 0, selector: '[data-opencli-click="1"]' });
      const nodeId = q?.nodeId || 0;
      if (nodeId) {
        try { await page.cdp('DOM.scrollIntoViewIfNeeded', { nodeId }); } catch { /* not scrollable */ }
        const box = await page.cdp('DOM.getBoxModel', { nodeId });
        const quad = box?.model?.content || box?.model?.border;
        if (quad && quad.length >= 6) {
          const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
          const y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;
          await page.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
          await page.wait({ time: 0.08 });
          await page.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
          await page.wait({ time: 0.08 });
          await page.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
          log.verbose(`click: <${marked.tag}> ${Math.round(x)},${Math.round(y)} via mouse`);
          return { ok: true, via: 'mouse' };
        }
      }
    } catch { /* fall through to DOM click */ }
  }
  await page.evaluate(clickJs(xpaths, skipDisabled));
  return { ok: true, via: 'dom' };
}

// 拟人随机等待：在 [min, max] 间取随机秒数（max 缺省为 min*2），避免机械节奏被反爬识别
export async function humanWait(page, minSeconds = 2.4, maxSeconds = null) {
  const min = Number(minSeconds) || 2.4;
  const max = Number(maxSeconds) || min * 2;
  const seconds = (Math.floor(Math.random() * (max * 1000 - min * 1000 + 1)) + min * 1000) / 1000;
  await page.wait({ time: seconds });
  return seconds;
}

// 页面跳转或大步骤之后的较长等待（5.3~6.8s）
export async function humanWaitLoaded(page) {
  return humanWait(page, 5.3, 6.8);
}

// 步骤包装：打印步骤日志 → 执行 → 拟人等待。六站所有步骤都走它，保证日志编号与节奏一致
export async function step(page, message, fn, min = 1.4, max = 3) {
  log.status(message);
  const out = await fn();
  await humanWait(page, min, max);
  return out;
}

// CDP 单条命令硬超时 30s，所以页面内等待按 20s 切片，由外层续跑
const IN_PAGE_SLICE_MS = 20_000;

// 生成「页面内等待」脚本：先立即判一次，再用 MutationObserver + 100ms 轮询兜底；
// 命中返回 { ok:true, ... }，到点返回 { ok:false, timedOut:true }（等价于 Playwright 的 waitForSelector）
function buildWaitPredicateJs(predicateExpr, timeoutMs) {
  return `(() => new Promise((resolve) => {
    let done = false;
    let obs = null;
    let timer = null;
    const finish = (v) => { if (done) return; done = true; if (timer) clearInterval(timer); if (obs) obs.disconnect(); resolve(v); };
    const check = () => { try { return (${predicateExpr}); } catch (e) { return null; } };
    const first = check();
    if (first && first.ok === true) { resolve(first); return; }
    try {
      obs = new MutationObserver(() => { const v = check(); if (v && v.ok === true) finish(v); });
      obs.observe(document.documentElement || document.body, { childList: true, subtree: true, attributes: true });
    } catch (e) {}
    const start = Date.now();
    timer = setInterval(() => {
      const v = check();
      if (v && v.ok === true) { finish(v); return; }
      if (Date.now() - start >= ${Number(timeoutMs)}) finish({ ok: false, timedOut: true });
    }, 100);
  }))()`;
}

// 执行页面内等待直到条件成立：按 20s 切片续跑到 deadline，超时抛 CommandExecutionError
export async function waitFor(page, predicateExpr, timeoutMs, label, hint) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const slice = Math.min(IN_PAGE_SLICE_MS, Math.max(1000, deadline - Date.now()));
    let r = null;
    try { r = await page.evaluate(buildWaitPredicateJs(predicateExpr, slice)); } catch { r = null; }
    if (r && r.ok === true) return r;
    if (Date.now() >= deadline) break;
  }
  throw new CommandExecutionError(`publish step timed out: ${label}`, hint || 'The site DOM may have changed — re-run to re-discover selectors');
}

// waitFor 的便捷版：直接传 xpath 列表，等待其中任一元素出现
export async function waitForElement(page, xpaths, timeoutMs, label, hint) {
  return waitFor(page, locatePredicateJs(xpaths), timeoutMs, label, hint);
}

// 等到元素出现再点击（waitForElement + clickXpath），点击落空会抛错而非静默返回
export async function clickWhenReady(page, xpaths, timeoutMs, label, hint, opts) {
  await waitForElement(page, xpaths, timeoutMs, label, hint);
  const r = await clickXpath(page, xpaths, opts);
  if (!r?.ok) throw new CommandExecutionError(`click failed: ${label}`, hint || 'The element became unclickable');
  return r;
}

// 带兜底的导航：导航前与导航中持续自动接受 JS 对话框，绕开 beforeunload 卡住导致的 30s 超时；
// 首次 waitUntil=load 失败则降级为 waitUntil=none 重试
export async function gotoWithRetry(page, url) {
  try { await page.handleJavaScriptDialog?.(true); } catch {}
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try { await page.handleJavaScriptDialog?.(true); } catch {}
    if (!stopped) setTimeout(tick, 400);
  };
  tick();
  const attempts = [
    { waitUntil: 'load', settleMs: 3000 },
    { waitUntil: 'none', settleMs: 1500 },
  ];
  let lastErr = null;
  for (const opt of attempts) {
    try {
      await page.goto(url, opt);
      stopped = true;
      return;
    } catch (e) {
      lastErr = e;
      log.verbose(`导航超时，清理对话框后重试（${JSON.stringify(opt)}）`);
      try { await page.handleJavaScriptDialog?.(true); } catch {}
    }
  }
  stopped = true;
  throw lastErr;
}

// 扩展名 → MIME，粘贴注入时在页面里构造 File 用
const MIME_BY_EXT = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.avi': 'video/x-msvideo',
  '.mkv': 'video/x-matroska', '.webm': 'video/webm', '.m4v': 'video/mp4',
};

// 把单个本地文件读成 base64，在页面内构造 File 并向编辑器派发 paste 事件（更贴近真人操作，优先于上传）
async function pasteMedia(page, filePath, editorSelector) {
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile())
    throw new ArgumentError(`Media not found: ${abs}`, 'Provide an absolute or relative path to a local file');
  const b64 = fs.readFileSync(abs).toString('base64');
  const mime = MIME_BY_EXT[path.extname(abs).toLowerCase()] || 'application/octet-stream';
  const name = path.basename(abs);
  return page.evaluate(`((b64, mime, name, sel) => {
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const file = new File([bytes], name, { type: mime });
    const dt = new DataTransfer();
    dt.items.add(file);
    const el = document.querySelector(sel);
    if (!(el instanceof HTMLElement)) return { ok: false, reason: 'editor-not-found' };
    el.focus();
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    return { ok: true };
  })(${JSON.stringify(b64)}, ${JSON.stringify(mime)}, ${JSON.stringify(name)}, ${JSON.stringify(editorSelector)})`);
}

// 逐个粘贴多个文件，中间留间隔（站点对连续粘贴有节流），任一失败即抛错
async function pasteMediaFiles(page, files, editorSelector, gapSeconds = 0.6) {
  for (const m of files) {
    const r = await pasteMedia(page, m, editorSelector);
    if (!r?.ok) throw new CommandExecutionError('media paste failed', 'The composer may have changed — re-run to re-discover selectors');
    await page.wait({ time: gapSeconds });
  }
}

// 给文件输入元素塞文件：优先 page.setFileInput，否则走 CDP DOM.setFileInputFiles
async function uploadFiles(page, selector, files) {
  if (page.setFileInput) {
    await page.setFileInput(files, selector);
    return;
  }
  if (page.cdp) {
    await page.cdp('DOM.enable');
    const doc = await page.cdp('DOM.getDocument', { depth: -1 });
    const rootId = doc?.root?.nodeId || 0;
    if (!rootId) throw new CommandExecutionError('DOM root not found for file upload');
    const q = await page.cdp('DOM.querySelector', { nodeId: rootId, selector });
    const nodeId = q?.nodeId || 0;
    if (!nodeId) throw new CommandExecutionError('file input node not found', 'Open the composer so the picker is present');
    await page.cdp('DOM.setFileInputFiles', { nodeId, files });
    return;
  }
  throw new CommandExecutionError('file upload needs setFileInput or a CDP endpoint', 'Use Browser Bridge or --cdp-endpoint');
}

// 生成页面脚本：定位文件输入（优先匹配 accept 的）并打标记返回 selector。
// 故意不校验可见性——隐藏的 input[type=file] 也必须能命中
function findFileInputJs(attr = 'data-opencli-file-input', acceptHint = '', xpaths = []) {
  return `(() => {
    ${IN_PAGE_HELPERS}
    let inputs = allByXpath('//input[@type="file"]');
    ${xpaths.length
      ? `const preferred = byXpaths(${JSON.stringify(xpaths)});
         if (preferred instanceof HTMLInputElement) inputs = [preferred].concat(inputs.filter(i => i !== preferred));`
      : ''}
    const hint = ${JSON.stringify(acceptHint)};
    const pick = (hint ? inputs.find(el => (el.getAttribute('accept') || '').toLowerCase().includes(hint)) : null)
      || inputs[0];
    if (!(pick instanceof HTMLInputElement)) return { ok: false };
    for (const p of document.querySelectorAll('[${attr}]')) p.removeAttribute('${attr}');
    pick.setAttribute('${attr}', '1');
    return { ok: true, selector: '[${attr}="1"]', accept: pick.getAttribute('accept') || '' };
  })()`;
}

// 生成探测脚本：判断媒体是否真的附加成功（file input 计数 / blob 预览 / 移除按钮 / 自定义 aria-label 命中其一）。
// errorPatterns 命中页面报错（如「文件过小」「无法上传」）时立刻返回 err，避免站点静默拒绝后被误判为成功
export function uploadProbeJs(expected, extraLabels = [], errorPatterns = []) {
  return `((expected, extras, errs) => {
    ${isVisibleFn()}
    const roots = [document.querySelector('[role="dialog"]'), document].filter(Boolean);
    let filesCount = 0;
    let removeCount = 0;
    let extraHit = 0;
    let blob = false;
    for (const d of roots) {
      const raw = (d.innerText || '');
      for (const p of errs) { if (new RegExp(p, 'i').test(raw)) return { ok: true, err: raw.replace(/\\s+/g, ' ').slice(0, 200) }; }
      for (const inp of d.querySelectorAll('input[type="file"]')) filesCount += (inp.files ? inp.files.length : 0);
      if (d.querySelector('img[src^="blob:"], video[src^="blob:"]')) blob = true;
      for (const b of d.querySelectorAll('[aria-label]')) {
        const a = (b.getAttribute('aria-label') || '').toLowerCase();
        if (/remove|移除|删除/.test(a)) removeCount++;
        if (extras.some(x => a.includes(String(x).toLowerCase()))) extraHit++;
      }
    }
    return { ok: filesCount >= expected || blob || removeCount >= expected || extraHit > 0, filesCount, blob, removeCount, extraHit };
  })(${JSON.stringify(expected)}, ${JSON.stringify(extraLabels)}, ${JSON.stringify(errorPatterns)})`;
}

// 附加媒体的统一入口：先试粘贴，失败回退文件输入上传；
// 页面上没有现成 input 时先点 selectFromComputer 唤出，最后用 readyProbeJs 等媒体就绪
export async function attachMedia(page, {
  files,
  pasteTargets = [],
  fileInputXpaths = ['//input[@type="file"]'],
  selectFromComputer = [],
  acceptHint = '',
  readyProbeJs,
  pasteTimeoutMs = 20000,
  readyTimeoutMs = 120000,
  label = '媒体',
  hint,
}) {
  if (pasteTargets.length) {
    try {
      const target = await page.evaluate(locateJs(pasteTargets, 'data-opencli-paste-target'));
      if (target?.ok) {
        await pasteMediaFiles(page, files, target.selector);
        const r = await waitFor(page, readyProbeJs, pasteTimeoutMs, `${label}（粘贴）`, hint);
        if (r) { log.verbose(`${label} 通过粘贴注入成功`); return { via: 'paste' }; }
      }
    } catch (e) {
      log.verbose(`粘贴注入未生效，回退文件输入：${e?.message || e}`);
    }
  }
  const findJs = findFileInputJs('data-opencli-file-input', acceptHint, fileInputXpaths);
  let fi = await page.evaluate(findJs);
  if (!fi?.ok && selectFromComputer.length) {
    log.verbose('未发现文件输入，点击"选择文件"唤出');
    await clickWhenReady(page, selectFromComputer, 20000, `${label}选择按钮`, hint);
    fi = await waitFor(page, findJs, 20000, `${label}文件输入`, hint);
  }
  if (!fi?.ok) throw new CommandExecutionError(`${label} file input not found`, hint || 'Open the composer so the picker is present');
  await uploadFiles(page, fi.selector, files);
  await waitFor(page, readyProbeJs, readyTimeoutMs, label, hint);
  return { via: 'upload', accept: fi.accept };
}

// 填正文：优先 fillText（带回填校验）→ 退化为 CDP insertText → 再退化为写 textContent + 派发 input 事件
export async function fillEditor(page, selector, content) {
  const filled = await page.fillText(selector, content);
  if (filled?.filled && filled?.verified) {
    log.verbose('正文经 fillText 校验通过');
    return;
  }
  await page.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (e instanceof HTMLElement) e.focus(); })()`);
  if (page.insertText) {
    await page.insertText(content);
    await page.wait({ time: 0.3 });
    log.verbose('正文经 insertText 填入');
    return;
  }
  const ok = await page.evaluate(`((text) => {
    const e = document.querySelector(${JSON.stringify(selector)});
    if (!(e instanceof HTMLElement)) return { ok: false };
    e.focus();
    e.textContent = text;
    e.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true }));
    return { ok: true };
  })(${JSON.stringify(content)})`);
  if (!ok?.ok) throw new CommandExecutionError('composer text could not be filled');
}

// 生成页面脚本：在锚点下方按 (x/8, 高/4, 宽/8) 聚类找出弹出菜单，取元素最多那组里最靠上的一项。
// 用于没有 role=menu 的自定义菜单（如 Instagram 创建菜单），完全不依赖文案
function popupFirstItemJs(attr, anchorXpaths) {
  return `(() => {
    ${IN_PAGE_HELPERS}
    const anchor = byXpaths(${JSON.stringify(anchorXpaths)}, document, false, true);
    if (!(anchor instanceof Element)) return { ok: false, reason: 'no-anchor' };
    const ar = anchor.getBoundingClientRect();
    const groups = new Map();
    for (const el of document.querySelectorAll('a[role="link"], [role="button"], [role="menuitem"], button')) {
      if (!(el instanceof Element) || !isVisible(el)) continue;
      if (el === anchor || anchor.contains(el) || el.contains(anchor)) continue;
      const r = el.getBoundingClientRect();
      if (r.y <= ar.y + 8 || r.y - ar.y > 360) continue;
      if (r.height < 32 || r.height > 90 || r.width < 120 || r.width > 420) continue;
      const key = Math.round(r.x / 8) + ':' + Math.round(r.height / 4) + ':' + Math.round(r.width / 8);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ el, r });
    }
    let best = null;
    for (const g of groups.values()) if (!best || g.length > best.length) best = g;
    if (!best) return { ok: false, reason: 'no-item' };
    best.sort((a, b) => (a.r.y - b.r.y) || (a.r.x - b.r.x));
    const pick = clickable(best[0].el);
    for (const p of document.querySelectorAll('[${attr}]')) p.removeAttribute('${attr}');
    pick.setAttribute('${attr}', '1');
    return { ok: true, selector: '[${attr}="1"]', tag: pick.tagName.toLowerCase(), count: best.length };
  })()`;
}

// 等弹出菜单出现并点击其首项（如 Instagram 的「帖子」），语言无关
export async function clickPopupFirstItem(page, anchorXpaths, {
  attr = 'data-opencli-popup', timeoutMs = 12000, label = '弹窗首项', hint, preferMouse = true,
} = {}) {
  const marked = await waitFor(page, popupFirstItemJs(attr, anchorXpaths), timeoutMs, label, hint);
  const r = await clickXpath(page, [`//*[@${attr}="1"]`], { preferMouse });
  if (!r?.ok) throw new CommandExecutionError(`click failed: ${label}`, hint || 'The popup item became unclickable');
  log.verbose(`${label}：<${marked.tag}> 共 ${marked.count} 项`);
  return marked;
}

// 页面脚本片段：页面上可能有多个 [role=dialog]，取面积最大的那个作为操作根（Facebook 就有大小两个）
const DIALOG_PICKER = `const pickDialog = (extra) => {
  const set = [];
  for (const el of [extra, ...document.querySelectorAll('[role="dialog"], [aria-modal="true"]')]) {
    if (el instanceof Element && isVisible(el) && !set.includes(el)) set.push(el);
  }
  if (!set.length) return document.body;
  set.sort((a, b) => {
    const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
    return (rb.width * rb.height) - (ra.width * ra.height);
  });
  return set[0];
};`;

// 生成页面脚本：在对话框顶部条带内取最右侧按钮（如 Instagram 的 Next / Share）。
// 纯几何定位，不依赖文案，因此不受界面语言影响
export function headerActionJs(attr, skipDisabled = true) {
  const a = JSON.stringify(attr);
  const skip = skipDisabled === false ? 'false' : 'true';
  return `(() => {
    ${isVisibleFn()}
    ${DIALOG_PICKER}
    const isDisabled = (el) => el.disabled === true || el.getAttribute('aria-disabled') === 'true'
      || (el.closest && el.closest('[aria-disabled="true"]') !== null);
    const root = pickDialog(null);
    const rr = root.getBoundingClientRect();
    const band = Math.min(140, Math.max(60, rr.height * 0.2));
    const cands = [];
    let sawDisabled = false;
    for (const el of root.querySelectorAll('[role="button"], button')) {
      if (!(el instanceof Element)) continue;
      if (!isVisible(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      if (r.top - rr.top > band) continue;
      if (r.width > 260 || r.height > 90) continue;
      if (${skip} && isDisabled(el)) { sawDisabled = true; continue; }
      cands.push({ el, r });
    }
    if (!cands.length) return { ok: false, disabled: sawDisabled };
    cands.sort((x, y) => (y.r.right - x.r.right) || (x.r.top - y.r.top));
    const pick = cands[0].el;
    for (const p of document.querySelectorAll('[${attr}]')) p.removeAttribute('${attr}');
    pick.setAttribute('${attr}', '1');
    return {
      ok: true,
      selector: '[' + ${a} + '="1"]',
      tag: pick.tagName.toLowerCase(),
      label: ((pick.getAttribute && pick.getAttribute('aria-label')) || pick.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40),
    };
  })()`;
}

// 生成页面脚本：在对话框底部取最靠下的宽按钮（如 Facebook / LinkedIn 的发布按钮），同样靠几何而非文案
export function footerActionJs(attr, rootXpaths = []) {
  const a = JSON.stringify(attr);
  return `(() => {
    ${IN_PAGE_HELPERS}
    ${DIALOG_PICKER}
    const isOff = (el) => el.disabled === true || el.getAttribute('aria-disabled') === 'true'
      || (el.closest && el.closest('[aria-disabled="true"]') !== null);
    const root = pickDialog(${rootXpaths.length ? `byXpaths(${JSON.stringify(rootXpaths)})` : 'null'});
    const rr = root.getBoundingClientRect();
    const cands = [];
    let sawDisabled = false;
    for (const el of root.querySelectorAll('[role="button"], button')) {
      if (!(el instanceof Element)) continue;
      if (!isVisible(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < Math.min(100, rr.width * 0.3)) continue;
      if (r.top - rr.top < rr.height * 0.55) continue;
      if (isOff(el)) { sawDisabled = true; continue; }
      cands.push({ el, r });
    }
    if (!cands.length) return { ok: false, disabled: sawDisabled };
    cands.sort((x, y) => (y.r.top - x.r.top) || (y.r.right - x.r.right));
    const pick = cands[0].el;
    for (const p of document.querySelectorAll('[${attr}]')) p.removeAttribute('${attr}');
    pick.setAttribute('${attr}', '1');
    return {
      ok: true,
      selector: '[' + ${a} + '="1"]',
      tag: pick.tagName.toLowerCase(),
      label: ((pick.getAttribute && pick.getAttribute('aria-label')) || pick.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40),
    };
  })()`;
}

// 页面脚本片段：找出教程/遮罩层（joyride 一类、大尺寸 modal/overlay），并排除含发帖框的容器以免误伤真正的对话框
const OVERLAY_FINDER = `const findOverlays = () => {
  const vw = window.innerWidth || document.documentElement.clientWidth || 0;
  const vh = window.innerHeight || document.documentElement.clientHeight || 0;
  const roots = [];
  const isComposer = (el) => !!el.querySelector('input[type="file"], [contenteditable="true"], [role="textbox"], form, textarea');
  const push = (el) => {
    if (!(el instanceof Element) || !isVisible(el) || roots.includes(el)) return;
    if (isComposer(el)) return;
    roots.push(el);
  };
  const big = (r) => r.width >= vw * 0.4 && r.height >= vh * 0.4;
  const tourish = /joyride|shepherd|introjs|driver|guide|coach|tutorial|onboard|walkthrough|spotlight/;
  for (const el of document.querySelectorAll('[aria-modal="true"]')) push(el);
  for (const el of document.querySelectorAll('[role="dialog"]')) { if (big(el.getBoundingClientRect())) push(el); }
  for (const el of document.querySelectorAll('div, section, aside')) {
    const cls = (el.className && typeof el.className === 'string' ? el.className : '').toLowerCase();
    if (tourish.test(cls)) { push(el); continue; }
    if (!/modal|overlay|mask|popup/.test(cls)) continue;
    if (big(el.getBoundingClientRect())) push(el);
  }
  return roots;
};`;

// 生成页面脚本：在遮罩里找关闭按钮（aria-label/文案关键词，或右上角小图标）并打标记
function buildDismissOverlayJs(attr = 'data-opencli-dismiss') {
  return `(() => {
    ${isVisibleFn()}
    ${OVERLAY_FINDER}
    const roots = findOverlays();
    if (!roots.length) return { ok: false, overlays: 0 };
    const words = /close|关闭|got it|知道了|我知道|skip|跳过|dismiss|不再显示|don't show|^ok$|确定|allow|允许/i;
    let best = null;
    for (const root of roots) {
      const rr = root.getBoundingClientRect();
      for (const el of root.querySelectorAll('button, [role="button"], a, [aria-label], svg')) {
        if (!(el instanceof Element) || !isVisible(el)) continue;
        const label = (el.getAttribute && el.getAttribute('aria-label')) || '';
        const txt = (el.textContent || '').trim();
        const r = el.getBoundingClientRect();
        const corner = r.width <= 56 && r.width > 0 && r.height <= 56 && r.height > 0
          && (rr.right - r.right) < 64 && (r.top - rr.top) < 64;
        if (words.test(label) || words.test(txt) || corner) { best = el; break; }
      }
      if (best) break;
    }
    if (!best) return { ok: false, overlays: roots.length, reason: 'no-dismiss-control' };
    for (const p of document.querySelectorAll('[${attr}]')) p.removeAttribute('${attr}');
    best.setAttribute('${attr}', '1');
    return {
      ok: true,
      overlays: roots.length,
      label: ((best.getAttribute && best.getAttribute('aria-label')) || best.textContent || '').trim().slice(0, 40),
    };
  })()`;
}

// 生成页面脚本：把点不掉的残留遮罩设为 pointer-events:none，防止挡住后续点击
function buildNeutralizeOverlaysJs() {
  return `(() => {
    ${isVisibleFn()}
    ${OVERLAY_FINDER}
    const roots = findOverlays();
    let n = 0;
    for (const el of roots) { if (el.style) { el.style.pointerEvents = 'none'; n++; } }
    return { ok: n > 0, count: n };
  })()`;
}

// 逐层关闭教程/遮罩，最后把残留层设为不拦截点击；返回被中和的层数
export async function dismissOverlays(page, times = 3) {
  for (let i = 0; i < times; i++) {
    const marked = await page.evaluate(buildDismissOverlayJs());
    if (!marked?.ok) break;
    const clicked = await clickXpath(page, ['//*[@data-opencli-dismiss="1"]']);
    if (!clicked?.ok) break;
    log.verbose(`已关闭一层遮罩/教程（${marked.label || '关闭按钮'}）`);
    await humanWait(page, 0.6, 1.2);
  }
  const neutralized = await page.evaluate(buildNeutralizeOverlaysJs());
  if (neutralized?.ok) log.verbose(`残留遮罩 ${neutralized.count} 层已设为不拦截点击`);
  return neutralized?.count || 0;
}

// 生成结果探测脚本：发帖框消失 / 页面出现成功文案 / 页面里出现帖子链接，三者命中其一即判定发布成功，
// 并返回按 base 补全后的帖子 URL（requireGone=false 时不强求发帖框消失，用于发布后跳转内容页的站点）
export function resultProbeJs({ goneSelector = '', urlPattern = '', texts = [], requireGone = true, base = '' }) {
  return `((goneSel, urlSrc, texts, requireGone, base) => {
    const gone = goneSel ? !document.querySelector(goneSel) : false;
    let url = '';
    if (urlSrc) {
      const re = new RegExp(urlSrc);
      const a = Array.from(document.querySelectorAll('a[href]')).find(x => re.test(x.getAttribute('href') || ''));
      if (a) url = a.getAttribute('href') || '';
    }
    const txt = ((document.body && document.body.innerText) || '').toLowerCase();
    const hit = texts.some(t => txt.includes(String(t).toLowerCase()));
    const ok = gone || hit || (!!url && !requireGone);
    let out = ok ? url : '';
    if (out && base && !/^https?:/i.test(out)) out = base.replace(/\\/$/, '') + out;
    return { ok, gone, hit, url: out };
  })(${JSON.stringify(goneSelector)}, ${JSON.stringify(urlPattern || '')}, ${JSON.stringify(texts)}, ${requireGone ? 'true' : 'false'}, ${JSON.stringify(base || '')})`;
}

// waitFor 的「不抛错」版本：超时返回 null，由调用方决定是重试还是报错。仅内部使用
async function waitResult(page, probeJs, timeoutMs, label, hint) {
  let last = null;
  try {
    last = await waitFor(page, probeJs, timeoutMs, label, hint);
  } catch {
    last = null;
  }
  return last;
}

// 等二次确认弹窗（如 TikTok 的 Continue to post?）出现并点击其右下按钮
export async function confirmDialog(page, {
  attr = 'data-opencli-confirm', timeoutMs = 15000, label = '确认弹窗', hint,
} = {}) {
  const marked = await waitFor(page, footerActionJs(attr), timeoutMs, label, hint);
  const r = await clickXpath(page, [`//*[@${attr}="1"]`]);
  if (!r?.ok) throw new CommandExecutionError(`click failed: ${label}`, hint || 'The confirm button became unclickable');
  log.verbose(`${label}：<${marked.tag}> "${marked.label}"`);
  return marked;
}

// 解析正文：--file 优先；位置参数若指向真实存在的 .txt 也自动读取，否则原样当作正文
export function resolveContent({ text, file }) {
  const textStr = String(text ?? '').trim();
  const fileStr = String(file ?? '').trim();
  if (fileStr) {
    if (!fs.existsSync(fileStr) || !fs.statSync(fileStr).isFile())
      throw new ArgumentError(`Content file not found: ${fileStr}`, 'Pass a readable .txt path to --file');
    return fs.readFileSync(fileStr, 'utf8').trim();
  }
  if (textStr) {
    if (/\.txt$/i.test(textStr) && fs.existsSync(textStr) && fs.statSync(textStr).isFile())
      return fs.readFileSync(textStr, 'utf8').trim();
    return textStr;
  }
  return '';
}

// 按扩展名判定媒体类型：image / video / unsupported
export function classifyMedia(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (IMAGE_EXT.has(ext)) return 'image';
  if (VIDEO_EXT.has(ext)) return 'video';
  return 'unsupported';
}

// 校验并归一化 --images/--videos：路径存在、格式受支持、类型与参数对应（图不能塞进 --videos）
export function normalizeMediaFiles({ images = '', videos = '' } = {}) {
  const one = (raw, kind) => raw.split(',').map(s => s.trim()).filter(Boolean).map(p => {
    const abs = path.resolve(p);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile())
      throw new ArgumentError(`Media file not found: ${abs}`, 'Provide absolute or relative paths to local files');
    const cls = classifyMedia(abs);
    if (cls === 'unsupported')
      throw new ArgumentError(`Unsupported media format: ${path.extname(abs)}`, 'Supported images: jpg/png/gif/webp/bmp; videos: mp4/mov/avi/mkv/webm/m4v');
    if (cls !== kind)
      throw new ArgumentError(`Expected ${kind} but got ${cls}: ${abs}`, 'Use --images for images and --videos for videos');
    return abs;
  });
  return { images: one(String(images ?? ''), 'image'), videos: one(String(videos ?? ''), 'video') };
}

// 视频站专用校验：必须有且只有一个视频
export function requireSingleVideo(videos, site) {
  const list = videos || [];
  if (list.length === 0)
    throw new ArgumentError(`${site} publish requires a video`, 'Pass --videos <path> (mp4/mov/avi/mkv/webm/m4v)');
  if (list.length > 1)
    throw new ArgumentError(`${site} publish accepts one video, got ${list.length}`, 'Pass a single --videos path');
  return list[0];
}

// 发布前置检查：cookie 中存在任一有效会话凭证才继续，否则抛 AuthRequiredError 提示先登录
export async function requireLogin(page, url, cookieNames, domain) {
  const cookies = await page.getCookies({ url });
  const names = new Set(cookies.map(c => c.name));
  const ok = Array.isArray(cookieNames)
    ? cookieNames.some(n => names.has(n) && cookies.some(c => c.name === n && c.value))
    : names.has(cookieNames);
  if (!ok) throw new AuthRequiredError(domain, `${domain} session cookie missing — run \`opencli ${domain.split('.')[0]} login\` first`);
}

// 生成统一的命令行参数表（text / file / images / videos / dry-run / timeout），六站共用
export function buildArgs({ media = 'image', timeout = 180, requiredMedia = false } = {}) {
  const args = [
    { name: 'text', positional: true, required: false, help: 'Post body text, or a path to a .txt file (auto-read)' },
    { name: 'file', type: 'string', required: false, help: 'Path to a .txt file whose content becomes the post body' },
  ];
  if (media === 'image' || media === 'both')
    args.push({ name: 'images', type: 'string', required: requiredMedia && media === 'image', help: 'Comma-separated local image paths (jpg/png/gif/webp/bmp)' });
  if (media === 'video' || media === 'both')
    args.push({ name: 'videos', type: 'string', required: media === 'video', help: 'Local video path (mp4/mov/avi/mkv/webm/m4v)' });
  args.push({ name: 'dry-run', type: 'bool', default: false, help: 'Fill everything, skip the final submit' });
  args.push({ name: 'timeout', type: 'int', default: timeout, help: `Max seconds for the publish command (default: ${timeout})` });
  return args;
}

// 统一输出行：一行 [{ status, url, post_id }]
export function row(status, url = '', postId = '') {
  return [{ status, url, post_id: postId }];
}

// 六站共用的 9 步编号与文案，步骤日志的唯一定义处（改这里即全站生效）
export const PHASE = {
  open: '1 打开发布入口页',
  overlay: '2 清理页面遮罩',
  entry: '3 触发发布入口',
  editor: '4 等待内容编辑框',
  media: '5 附加媒体',
  text: '6 填写正文',
  settings: '7 发布前设置',
  publish: '8 点击发布按钮',
  result: '9 等待发布结果',
};

// 统一收尾：等发布结果 →（可选）重试一次 → 解析 postId → 打印结果 → 输出行
export async function publishFinish(page, {
  probeJs, timeoutMs, hint, idPattern = null, retry = null, stripQuery = false, firstMs = null,
}) {
  let last = await waitResult(page, probeJs, firstMs ?? timeoutMs, PHASE.result, hint);
  if (!last?.ok && retry) {
    try { await retry(); } catch (e) { log.verbose(`发布重试未生效（${e?.message || e}）`); }
    await humanWaitLoaded(page);
    last = await waitResult(page, probeJs, timeoutMs, PHASE.result, hint);
  }
  await humanWaitLoaded(page);
  let url = last?.url || '';
  if (stripQuery) url = url.split('?')[0];
  const postId = idPattern ? ((url.match(idPattern) || [])[1] || '') : '';
  log.status(last?.ok ? (url ? `已发布：${url}` : '已发布（未捕获帖子链接）') : '已点击发布（未捕获发布确认）');
  return row('published', url, postId);
}
