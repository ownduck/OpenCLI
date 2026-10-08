/**
 * 六站 publish 共用：Playwright connectOverCDP 会话。
 * 始终 newPage；disconnect 只断客户端不杀 Chrome；成功才 closeTab。
 */
import { chromium } from 'playwright-core';
import { CommandExecutionError } from '@jackwener/opencli/errors';
import { log } from '@jackwener/opencli/logger';

/** @returns {string} */
export function requireCdpEndpoint() {
  const endpoint = (process.env.OPENCLI_CDP_ENDPOINT || '').trim();
  if (!endpoint) {
    throw new CommandExecutionError(
      'publish requires a CDP endpoint',
      'Pass --cdp-endpoint=http://127.0.0.1:<port> or set OPENCLI_CDP_ENDPOINT',
    );
  }
  return endpoint.replace(/\/$/, '');
}

/**
 * @param {{ entryUrl: string, endpoint?: string }} opts
 */
export async function openPublishSession({ entryUrl, endpoint = requireCdpEndpoint() }) {
  log.status(`Playwright connectOverCDP → ${endpoint}`);
  const browser = await chromium.connectOverCDP(endpoint);
  const context = browser.contexts()[0];
  if (!context) {
    await browser.close().catch(() => {});
    throw new CommandExecutionError(
      'No browser context on CDP endpoint',
      'Is the target Chrome running with remote debugging?',
    );
  }

  log.status(`新标签打开：${entryUrl}`);
  const page = await context.newPage();
  page.setDefaultTimeout(120_000);

  const disconnect = async () => {
    try { await browser.close(); } catch { /* ignore */ }
  };
  const closeTab = async () => {
    try { if (!page.isClosed()) await page.close(); } catch { /* ignore */ }
  };

  return { browser, context, page, disconnect, closeTab };
}

/**
 * 包一层：成功关标签；dry_run / 失败保留；始终 disconnect。
 * fn 签名：({ page, context }) => Promise<[{ status }]>
 * @param {{ entryUrl: string, fn: Function }} opts
 */
export async function runPublishSession({ entryUrl, fn }) {
  const session = await openPublishSession({ entryUrl });
  const { page, context, disconnect, closeTab } = session;
  let publishedOk = false;
  let dryRunOk = false;
  try {
    const out = await fn({ page, context });
    const status = Array.isArray(out) ? out[0]?.status : out?.status;
    if (status === 'published') publishedOk = true;
    else if (status === 'dry_run') dryRunOk = true;
    return out;
  } catch (err) {
    log.status('发布失败，保留标签页以便查看');
    throw err;
  } finally {
    if (publishedOk) {
      await closeTab();
      log.status('发布成功，已关闭发布标签页');
    } else if (dryRunOk) {
      log.status('dry-run 完成，保留标签页以便查看');
    }
    await disconnect();
    log.verbose('已断开 Playwright CDP 连接（浏览器保持运行）');
  }
}

/**
 * @param {import('playwright-core').BrowserContext} context
 * @param {string} url
 * @param {string[]} cookieNames
 * @param {string} hint
 */
export async function assertCookies(context, url, cookieNames, hint) {
  const cookies = await context.cookies(url);
  const names = new Set(cookies.filter((c) => c.value).map((c) => c.name));
  const ok = cookieNames.some((n) => names.has(n));
  if (!ok) {
    throw new CommandExecutionError(`${hint} session cookie missing`, `Log in on the target Chrome profile, then retry`);
  }
}

/**
 * @param {import('playwright-core').Page} page
 * @param {number} minMs
 * @param {number} [maxMs]
 */
export async function randomWait(page, minMs = 800, maxMs = minMs * 2) {
  const lo = Math.max(0, Number(minMs) || 0);
  const hi = Math.max(lo, Number(maxMs) || lo);
  const ms = Math.floor(Math.random() * (hi - lo + 1)) + lo;
  log.verbose(`拟人等待 ${(ms / 1000).toFixed(2)}s`);
  await page.waitForTimeout(ms);
  return ms;
}

/**
 * @param {import('playwright-core').Page} page
 * @param {number} minSec
 * @param {number} [maxSec]
 */
export async function humanWait(page, minSec = 1.4, maxSec = null) {
  const min = Number(minSec) || 1.4;
  const max = Number(maxSec) || min * 2;
  return randomWait(page, Math.round(min * 1000), Math.round(max * 1000));
}

/**
 * @param {import('playwright-core').Page} page
 * @param {string} message
 * @param {() => Promise<any>} fn
 * @param {number} [minSec]
 * @param {number} [maxSec]
 */
export async function step(page, message, fn, minSec = 1.4, maxSec = 3) {
  log.status(message);
  const out = await fn();
  await humanWait(page, minSec, maxSec);
  return out;
}

/**
 * @param {import('playwright-core').Page} page
 * @param {string[]} sels
 * @param {number} [timeout]
 */
export async function firstVisible(page, sels, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const sel of sels) {
      const loc = page.locator(sel).first();
      try {
        if (await loc.isVisible({ timeout: 500 })) return loc;
      } catch { /* next */ }
    }
    await page.waitForTimeout(300);
  }
  return null;
}

/**
 * @param {import('playwright-core').Page} page
 * @param {import('playwright-core').Locator} loc
 * @param {string} [hint]
 */
export async function mouseClickLocator(page, loc, hint = 'element') {
  const box = await loc.boundingBox();
  if (!box) throw new CommandExecutionError(`${hint} has no bounding box`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await randomWait(page, 80, 180);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  return box;
}

/**
 * 等 dialog 消失或成功文案（不抓 url）。
 * @param {import('playwright-core').Page} page
 * @param {{ timeoutMs?: number, goneSel?: string, successRe?: RegExp, hint?: string }} opts
 */
export async function waitPublishDone(page, {
  timeoutMs = 90000,
  goneSel = '[role="dialog"]',
  successRe = /已发布|已分享|post shared|published|your post/i,
  hint = '发布结果',
} = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const gone = !(await page.locator(goneSel).first().isVisible().catch(() => false));
    const body = await page.locator('body').innerText().catch(() => '');
    if (gone || successRe.test(body)) return true;
    await page.waitForTimeout(800);
  }
  throw new CommandExecutionError(`publish step timed out: ${hint}`);
}
