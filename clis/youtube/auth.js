import { AuthRequiredError, CommandExecutionError } from '@jackwener/opencli/errors';
import { registerSiteAuthCommands } from '../_shared/site-auth.js';

async function hasGoogleSessionCookie(page) {
  const cookies = await page.getCookies({ url: 'https://www.youtube.com' });
  const names = new Set(cookies.map(c => c.name));
  return names.has('SID') || names.has('SAPISID') || names.has('__Secure-1PSID');
}

async function verifyYoutubeIdentity(page) {
  if (!await hasGoogleSessionCookie(page)) {
    throw new AuthRequiredError('www.youtube.com', 'Google session cookies missing');
  }
  await page.goto('https://www.youtube.com/');
  await page.wait(3);
  const probe = await page.evaluate(`
    (() => {
      const cfg = (typeof window !== 'undefined' && window.ytcfg && typeof window.ytcfg.get === 'function') ? window.ytcfg : null;
      // ytcfg LOGGED_IN is the reliable signed-in signal; the avatar button is a fallback.
      const loggedIn = !!(cfg && cfg.get('LOGGED_IN') === true) || !!document.querySelector('#avatar-btn');
      if (!loggedIn) {
        return { kind: 'auth', detail: 'YouTube ytcfg LOGGED_IN not true and no avatar — not signed in' };
      }
      let name = '';
      try { name = (cfg && cfg.get('USER_ACCOUNT_NAME')) || ''; } catch {}
      if (!name) {
        try { const ctx = cfg && cfg.get('INNERTUBE_CONTEXT'); name = (ctx && ctx.user && ctx.user.identityName) || ''; } catch {}
      }
      if (!name) {
        // The masthead avatar only exposes a localized "Account menu" label,
        // which is not a name — reject anything menu-like in any locale.
        const aria = (document.querySelector('#avatar-btn')?.getAttribute('aria-label') || '').trim();
        if (aria && !/menu|菜单|メニュー|메뉴|帳戶|账户/i.test(aria)) name = aria;
      }
      return { ok: true, name: String(name || '') };
    })()
  `);
  if (probe?.kind === 'auth') throw new AuthRequiredError('www.youtube.com', probe.detail);
  if (!probe?.ok) throw new CommandExecutionError(`Unexpected YouTube probe: ${JSON.stringify(probe)}`);
  return { name: probe.name };
}

registerSiteAuthCommands({
  site: 'youtube',
  domain: 'www.youtube.com',
  loginUrl: 'https://accounts.google.com/ServiceLogin?service=youtube&continue=https%3A%2F%2Fwww.youtube.com%2F',
  columns: ['name'],
  quickCheck: hasGoogleSessionCookie,
  verify: verifyYoutubeIdentity,
  poll: async (page) => {
    if (!await hasGoogleSessionCookie(page)) {
      throw new AuthRequiredError('www.youtube.com', 'Waiting for Google session cookies');
    }
    return verifyYoutubeIdentity(page);
  },
});
