import { AuthRequiredError } from '@jackwener/opencli/errors';
import { registerSiteAuthCommands } from '../_shared/site-auth.js';

/** One-shot /setting rehydrate after cookies newly appear during login poll. */
const rehydratedDuringPoll = new WeakSet();
/** Pages that observed missing session cookies during this login poll. */
const sawMissingCookie = new WeakSet();

async function hasTiktokSessionCookie(page) {
  const cookies = await page.getCookies({ url: 'https://www.tiktok.com' });
  const names = new Set(cookies.map(c => c.name));
  return names.has('sessionid') || names.has('sessionid_ss');
}

const READ_IDENTITY_JS = `(() => {
  const raw = document.querySelector('script[id="__UNIVERSAL_DATA_FOR_REHYDRATION__"]')?.textContent;
  if (raw) {
    let data;
    try { data = JSON.parse(raw); } catch { data = null; }
    const scope = data?.['__DEFAULT_SCOPE__'] || {};
    const seen = new Set();
    const stack = [scope];
    let fallback = null;
    while (stack.length) {
      const node = stack.pop();
      if (!node || typeof node !== 'object' || seen.has(node)) continue;
      seen.add(node);
      if (Array.isArray(node)) { stack.push(...node); continue; }
      const u = node.user;
      if (u && typeof u === 'object') {
        const sec = u.secUid || u.sec_uid;
        if (sec) {
          const row = {
            sec_uid: String(sec),
            username: String(u.uniqueId || u.unique_id || u.username || ''),
            nickname: String(u.nickname || u.nickName || ''),
          };
          if (u.isOwner || u.is_owner || u.isCurrentUser) return row;
          if (!fallback) fallback = row;
        }
      }
      for (const v of Object.values(node)) if (v && typeof v === 'object') stack.push(v);
    }
    if (fallback) return fallback;
  }
  const scopeEl = document.querySelector('[data-e2e="nav-profile"]') || document.querySelector('[data-e2e="profile-icon"]');
  const a = scopeEl && scopeEl.querySelector('a[href^="/@"]');
  const href = a && a.getAttribute('href');
  const m = href && href.match(/^\\/@([^/?#]+)/);
  return m ? { sec_uid: '', username: decodeURIComponent(m[1]), nickname: '' } : null;
})()`;

async function readIdentity(page) {
  const info = await page.evaluate(READ_IDENTITY_JS).catch(() => null);
  if (!info?.username) return null;
  return { sec_uid: info.sec_uid || '', username: info.username, nickname: info.nickname || '' };
}

async function verifyTiktokIdentity(page, { phase, allowRehydrate } = {}) {
  const cookies = await page.getCookies({ url: 'https://www.tiktok.com' });
  const names = new Set(cookies.map(c => c.name));
  if (!names.has('sessionid') && !names.has('sessionid_ss')) {
    throw new AuthRequiredError('www.tiktok.com', 'TikTok session cookie (sessionid) missing');
  }
  const current = await readIdentity(page);
  if (current) return current;

  // login precheck / normal poll: do not navigate — avoids refresh storms before the user can log in.
  // Only rehydrate once when cookies newly appear mid-poll (OAuth finished on this or a sibling tab).
  if (phase === 'login-precheck' || (phase === 'poll' && !allowRehydrate)) {
    throw new AuthRequiredError('www.tiktok.com', 'TikTok identity not rendered on the current page yet');
  }
  if (phase === 'poll') {
    if (rehydratedDuringPoll.has(page)) {
      throw new AuthRequiredError('www.tiktok.com', 'TikTok identity not rendered on the current page yet');
    }
    rehydratedDuringPoll.add(page);
  }

  await page.goto('https://www.tiktok.com/setting');
  await page.wait(2);
  const info = await readIdentity(page);
  if (!info) {
    throw new AuthRequiredError('www.tiktok.com', 'TikTok universal data has no owner user — identity not rehydrated');
  }
  return info;
}

registerSiteAuthCommands({
  site: 'tiktok',
  domain: 'tiktok.com',
  loginUrl: 'https://www.tiktok.com/',
  columns: ['sec_uid', 'username', 'nickname'],
  quickCheck: hasTiktokSessionCookie,
  verify: verifyTiktokIdentity,
  poll: async (page, options) => {
    if (!await hasTiktokSessionCookie(page)) {
      sawMissingCookie.add(page);
      throw new AuthRequiredError('www.tiktok.com', 'Waiting for TikTok session cookies');
    }
    const justGotCookies = sawMissingCookie.has(page);
    if (justGotCookies) sawMissingCookie.delete(page);
    return verifyTiktokIdentity(page, { ...options, allowRehydrate: justGotCookies });
  },
});
