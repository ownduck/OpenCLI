import { AuthRequiredError, CommandExecutionError } from '@jackwener/opencli/errors';
import { registerSiteAuthCommands } from '../_shared/site-auth.js';

async function hasInstagramSessionCookie(page) {
  const cookies = await page.getCookies({ url: 'https://www.instagram.com' });
  return cookies.some(c => c.name === 'sessionid' && c.value);
}

async function verifyInstagramIdentity(page) {
  if (!await hasInstagramSessionCookie(page)) {
    throw new AuthRequiredError('www.instagram.com', 'Instagram sessionid cookie missing');
  }
  await page.goto('https://www.instagram.com/');
  await page.wait(2);
  const result = await page.evaluate(`(async () => {
    try {
      const uid = (document.cookie.split('; ').find(c => c.startsWith('ds_user_id=')) || '').split('=')[1] || '';
      if (!uid) return { kind: 'auth', detail: 'Instagram ds_user_id cookie missing' };
      const link = [...document.querySelectorAll('a')].find(el => /^\\/[^\\/?#]+\\/?$/.test(el.getAttribute('href') || '') && el.querySelector('img'));
      const username = (link && (link.getAttribute('href').match(/^\\/([^\\/?#]+)/) || [])[1]) || '';
      if (!username) return { kind: 'dom', detail: 'Instagram profile link not found in DOM' };
      let full_name = '';
      try {
        const r = await fetch('/' + username + '/?__a=1&__d=dis', { credentials: 'include', headers: { 'X-IG-App-ID': '936619743392459', 'Accept': 'application/json' } });
        if (r.ok) {
          const u = (await r.json())?.graphql?.user;
          if (u?.username) return { ok: true, user_id: uid, username: String(u.username), full_name: String(u.full_name || '') };
          if (u?.full_name) full_name = String(u.full_name);
        }
      } catch (_) {}
      return { ok: true, user_id: uid, username, full_name };
    } catch (e) {
      return { kind: 'exception', detail: String(e && e.message || e) };
    }
  })()`);
  if (result?.kind === 'auth') throw new AuthRequiredError('www.instagram.com', result.detail);
  if (result?.kind === 'dom') throw new CommandExecutionError(`Instagram profile link not found: ${result.detail}`);
  if (result?.kind === 'exception') throw new CommandExecutionError(`Instagram whoami failed: ${result.detail}`);
  if (!result?.ok) throw new CommandExecutionError(`Unexpected Instagram probe: ${JSON.stringify(result)}`);
  return { user_id: result.user_id, username: result.username, full_name: result.full_name || result.username };
}

registerSiteAuthCommands({
  site: 'instagram',
  domain: 'instagram.com',
  loginUrl: 'https://www.instagram.com/',
  columns: ['user_id', 'username', 'full_name'],
  quickCheck: hasInstagramSessionCookie,
  verify: verifyInstagramIdentity,
  poll: async (page) => {
    if (!await hasInstagramSessionCookie(page)) {
      throw new AuthRequiredError('www.instagram.com', 'Waiting for Instagram sessionid cookie');
    }
    return verifyInstagramIdentity(page);
  },
});
