# OpenCLI：`login` / `whoami` 原理与复刻指南

本文基于仓库内共享框架与多站点适配器源码，说明登录态检查与「打开登录页并等待登录完成」的实现方式，并说明如何把代码拆成可迁移模块，迁入别的软件。

覆盖站点：`xiaohongshu`、`facebook`、`instagram`、`tiktok`、`youtube`、`twitter`、`linkedin`（行为同构，钩子不同）。

---

## 1. 设计目标

| 目标 | 做法 |
|------|------|
| 不碰账号密码 | 复用用户 Chrome 里已有登录态（Cookie / 会话） |
| 确定性输出 | `whoami` / `login` 返回固定列结构，Agent/脚本可分支 |
| 人机协作登录 | `login` 打开前台登录页，轮询直到认证成功或超时 |
| 站点差异隔离 | 共享状态机 + 每站注入「快速探测 / 身份校验 / 轮询」钩子 |
| 可迁移 | 状态机 / 错误契约 / Page 接口 / 站点钩子四层解耦，不绑 OpenCLI CLI |

核心文件：

| 文件 | 职责 | 迁移优先级 |
|------|------|------------|
| `clis/_shared/site-auth.js` | 注册通用 `whoami` + `login` 状态机 | **必迁核心逻辑**（去掉 `cli()` 注册） |
| `clis/*/auth.js` | 各站 Cookie + verify/poll | **按站迁钩子** |
| `src/errors.ts` | `AuthRequiredError` / `TimeoutError` | **迁精简错误类型** |
| `src/types.ts`（`IPage`） | `goto` / `wait` / `evaluate` / `getCookies` | **迁接口，不迁实现** |
| `src/browser/*`、`daemon`、`extension` | Bridge / CDP | 用你软件已有浏览器通道替换 |
| `src/registry.ts`、`cli.ts`、`commands/auth.ts` | OpenCLI 命令树 / 跨站 status | **不必迁** |

---

## 2. 总体架构：共享状态机 + 站点钩子

几乎所有站点的 `login` / `whoami` 都不是手写两套命令，而是调用：

```js
registerSiteAuthCommands({
  site, domain, loginUrl, columns,
  quickCheck,  // 可选：只看 Cookie，不导航
  verify,      // 必填：完整身份探测（whoami / login 预检）
  poll,        // 可选：login 轮询时用（可比 verify 更轻）
});
```

框架负责：

1. 注册两条 CLI：`<site> whoami`、`<site> login`
2. 统一会话策略：`Strategy.COOKIE`、`browser: true`、`siteSession: 'persistent'`、`navigateBefore: false`
3. `login` 默认前台窗口（`defaultWindowMode: 'foreground'`），方便用户扫码/输密码
4. 把站点返回的身份对象规范成 `{ logged_in: true, site, ...columns }`

站点只负责回答三个问题：

1. **Cookie 在不在？**（`quickCheck`）
2. **当前会话是谁？**（`verify`）
3. **用户还在登录中时怎么探测？**（`poll`，通常 = Cookie 检查 → 再 `verify`）

```text
┌─────────────────────────────────────────────────────────┐
│              registerSiteAuthCommands (共享)              │
│  whoami ──► verify(page)                                │
│  login  ──► verify? ──yes──► already_logged_in          │
│              │ no                                       │
│              ▼                                          │
│           goto(loginUrl) → loop poll every 2s           │
│              │ success / timeout                        │
│              ▼                                          │
│         login_complete / TimeoutError                   │
└─────────────────────────────────────────────────────────┘
         ▲                ▲                ▲
         │                │                │
   quickCheck        verify/poll      loginUrl/domain
   (Cookie)       (API / DOM / 跳转)    (站点配置)
```

---

## 3. 两层登录态模型

### 3.1 快速层：`quickCheck`（只读 Cookie）

- 通过 Browser Bridge / CDP 的 `page.getCookies({ url })` 读浏览器 Cookie
- **不导航、不执行页面 JS**，适合批量 `opencli auth status`
- 返回 `boolean` 或 `{ logged_in: boolean, ... }`
- 只能证明「像已登录」，不能保证会话未过期、未风控

### 3.2 完整层：`verify`（身份探测）

- 真正证明「当前浏览器会话可用」，并返回可展示身份字段
- 常见手段（可组合）：
  - 带 `credentials: 'include'` 调站点 API
  - 打开「仅登录用户可访问」的页面，看是否被踢到 `/login`
  - 从 Cookie 取值（如 Facebook `c_user`）再配合页面跳转解析 vanity
- **未登录必须抛 `AuthRequiredError`**（不能静默返回空对象）——共享层靠这个异常区分「未登录」与「其它故障」

### 3.3 轮询层：`poll`（login 等待中）

- `login` 打开登录页后，每约 2 秒调用一次
- 典型写法：先 Cookie 探针，过了再跑完整 `verify`
- 未完成时继续抛 `AuthRequiredError`；其它错误直接冒泡（不要当成「还在等登录」）

---

## 4. `whoami` 原理

注册参数要点（`site-auth.js`）：

```text
access: read
strategy: COOKIE
browser: true
navigateBefore: false   // 由 verify 自己决定要不要 goto
siteSession: persistent
columns: ['logged_in', 'site', ...站点自定义列]
func: () => normalizeIdentity(site, await verify(page))
```

执行路径：

```text
opencli <site> whoami
  → 连接 Browser Bridge（复用 Chrome 登录态）
  → 拿到 IPage
  → 调用站点 verify(page)
  → 成功：{ logged_in: true, site, ...身份字段 }
  → 失败 AuthRequiredError：exit 提示未登录 / 需 login
```

要点：

- `whoami` **不会**打开登录页；它只探测
- 身份字段由站点 `columns` 声明，框架自动加上 `logged_in`、`site`
- 未登录用类型化错误 `AUTH_REQUIRED`（exit code 对应 `NOPERM`），便于脚本：`$? -eq 77` 一类分支

---

## 5. `login` 原理（状态机）

```text
opencli <site> login [--timeout 300]
```

### 5.1 状态机伪代码

```js
// 1) 已登录短路
try {
  identity = await verify(page);           // phase: identity
  return { status: 'already_logged_in', ...identity };
} catch (e) {
  if (!(e instanceof AuthRequiredError)) throw e;
}

// 2) 打开登录页（前台）
await page.goto(loginUrl);

// 3) 轮询直到成功或超时（默认 300s，间隔 ~2s）
deadline = now + timeoutSeconds;
while (now < deadline) {
  await page.wait(~2s);
  try {
    identity = await poll(page) ?? verify(page);  // phase: poll
    return { status: 'login_complete', ...identity };
  } catch (e) {
    if (!(e instanceof AuthRequiredError)) throw e;
    // 继续等用户完成扫码/密码/二次验证
  }
}
throw TimeoutError(...);
```

### 5.2 状态与输出列

| status | 含义 |
|--------|------|
| `already_logged_in` | 打开 login 前 `verify` 已成功（你看到的小红书场景） |
| `login_complete` | 曾未登录，用户在超时内完成登录且 `poll`/`verify` 通过（Facebook 场景） |

公共列：`status, logged_in, site, ...站点 columns`

### 5.3 为何 `navigateBefore: false`

COOKIE 策略默认会先导航到 `https://{domain}`。auth 命令关掉预导航，因为：

- `verify` / `poll` 自己控制目标 URL（创作者后台、`/me`、passport 等）
- `login` 要精确打开 `loginUrl`，避免被默认 domain 干扰

### 5.4 为何 `siteSession: 'persistent'`

登录过程可能跨多次 poll、跨标签页；persistent 保持同一站点会话租约，避免 ephemeral 会话过早释放导致 Cookie/标签丢失。

### 5.5 前台窗口

`login` 设置 `defaultWindowMode: 'foreground'`，把 Chrome 拉到前台，让用户完成人机登录；`whoami` 无此默认（可后台探测）。

---

## 6. 小红书实现（`clis/xiaohongshu/auth.js`）

### 6.1 配置

| 项 | 值 |
|----|-----|
| site | `xiaohongshu` |
| domain | `creator.xiaohongshu.com` |
| loginUrl | `https://creator.xiaohongshu.com/` |
| columns | `username`, `followers` |
| 会话 Cookie | `web_session`（针对 creator 域） |

注意：登录入口用的是**创作者中心**域名，不是 `www.xiaohongshu.com`。很多写操作（发布、创作者数据）依赖 creator 域会话。

### 6.2 `quickCheck`：Cookie 探针

```js
async function hasXhsSessionCookies(page) {
  const cookies = await page.getCookies({ url: 'https://creator.xiaohongshu.com' });
  const names = new Set(cookies.map(c => c.name));
  return names.has('web_session');
}
```

- 有 `web_session` → 粗判已登录
- 无导航、无 `evaluate`，最快

### 6.3 `verify`：创作者个人信息 API

```text
1. page.goto('https://creator.xiaohongshu.com/new/home')
2. page.evaluate 内：
     fetch('/api/galaxy/creator/home/personal_info', { credentials: 'include' })
3. HTTP 非 ok → AuthRequiredError
4. 解析 data.name / data.fans_count → { username, followers }
```

关键点：

- 在**页面上下文**发 fetch，自动带上该域 Cookie（与 Node 直连不同）
- API 失败即视为未登录/会话无效，而不是返回空用户

### 6.4 `poll`

```text
无 web_session → AuthRequiredError('Waiting for ... cookies')
有 cookie → verifyXhsIdentity(page)
```

### 6.5 与你终端现象的对应

| 命令 | 现象 | 解释 |
|------|------|------|
| `xiaohongshu whoami` | `CDP Runtime.evaluate timed out after 30s` | `verify` 要 `goto` + 页内 `fetch`/`evaluate`；CDP 执行超时（页卡死、扩展/bridge 忙、风控页挂起等），属于连通/页面层故障，不一定是「未登录」 |
| `xiaohongshu login` → `already_logged_in` | 预检 `verify` 成功 | Cookie + personal_info 正常，状态机短路，**不会**再打开登录页 |

复刻建议：对 `verify` 里的导航/evaluate 单独设超时与重试；超时不要误报成「未登录」，应报「探测失败 / 浏览器无响应」。

---

## 7. Facebook 实现（`clis/facebook/auth.js`）

### 7.1 配置

| 项 | 值 |
|----|-----|
| site | `facebook` |
| domain | `facebook.com` |
| loginUrl | `https://www.facebook.com/login.php` |
| columns | `user_id`, `vanity`, `profile_url` |
| 会话 Cookie | `c_user`（且 value 非空） |

### 7.2 `quickCheck`

```js
cookies = page.getCookies({ url: 'https://www.facebook.com' })
return cookies.some(c => c.name === 'c_user' && c.value)
```

### 7.3 `verify`：Cookie + `/me` 跳转解析

```text
1. 无 c_user → AuthRequiredError
2. 读出 c_user.value 作为 user_id
3. page.goto('https://www.facebook.com/me')
4. wait(2)
5. evaluate → location.href
6. 从 URL 解析 vanity（路径第一段）
7. vanity 为空 / login.php / checkpoint → AuthRequiredError
8. 返回 { user_id, vanity, profile_url }
```

特点：

- **不依赖私有 Graph API**，用「登录态下 `/me` 会 302 到个人主页」这一产品行为
- 同时识别 checkpoint（风控/二次验证）为未就绪登录
- `user_id` 来自 Cookie，稳定；`vanity` 来自最终 URL，可读

### 7.4 `poll`

与小红书同型：先等 `c_user` 出现，再跑完整 `verify`。

### 7.5 与你终端现象的对应

| 命令 | 现象 | 解释 |
|------|------|------|
| `facebook login` → `login_complete`，约 107s | 初次 `verify` 失败 → 打开 `login.php` → 你在浏览器完成登录 → 某次 poll 成功 | 典型人机协作路径 |
| `facebook whoami` | 直接给出同一套身份列 | 仅 `verify`，无登录 UI |

---

## 8. 运行时依赖（复刻时要对齐的前提）

```text
你的 CLI / Agent / App
    ↓
浏览器控制通道（OpenCLI: Browser Bridge + daemon；或 Playwright/Puppeteer/CDP/自研扩展）
    ↓
用户日常 Chrome（已装扩展 / 已开远程调试 / 可控 Profile）
    ↓
目标站点 Cookie / 页面 / XHR
```

原则：

1. **凭据不离开浏览器** —— CLI 只发「读 Cookie / 导航 / evaluate」指令
2. **登录态 = 浏览器 Profile 的会话**，不是 CLI 自己存的 token 文件（除非你另做 OAuth）
3. `doctor` 类诊断应先于业务命令：扩展连通、daemon、目标 Profile

OpenCLI 读 Cookie：`IPage.getCookies` → Bridge `cookies` 命令或 CDP `Network.getCookies`。

---

## 9. 多站对照：行为同构，钩子不同

下列站点 **全部** 调用 `registerSiteAuthCommands`，`whoami` / `login` 状态机完全相同。

| 站点 | Cookie 探针 | 身份 `verify` | loginUrl | 身份列 |
|------|-------------|---------------|----------|--------|
| xiaohongshu | `web_session`（creator） | creator `personal_info` API | creator 首页 | username, followers |
| facebook | `c_user` | `/me` 跳转解析 vanity | `login.php` | user_id, vanity, profile_url |
| instagram | `sessionid` | `/api/v1/users/{ds_user_id}/info/` | `/accounts/login/` | user_id, username, full_name |
| tiktok | `sessionid`/`sid_tt`/`uid_tt` | hydration JSON 里 owner user | `/login` | sec_uid, username, nickname |
| youtube | `SID`/`SAPISID`/`__Secure-1PSID` | `ytcfg.LOGGED_IN` 或 `#avatar-btn` | Google ServiceLogin | name |
| twitter | `auth_token` **且** `ct0` | `/home` Profile Tab DOM | `/i/flow/login` | username, url |
| linkedin | `li_at` | `/voyager/api/me` + JSESSIONID CSRF | `/login` | public_id, plain_id, name |

`verify` 手段分类（迁移时按类实现即可）：

| 类型 | 代表 | 做法 |
|------|------|------|
| 页内 API | 小红书、Instagram、LinkedIn | `goto` → `evaluate` 里 `fetch(..., credentials:'include')` |
| URL 跳转 | Facebook | `goto` 受保护 URL → 解析 `location.href` |
| DOM 信号 | Twitter、YouTube | `goto` → 查登录专属节点 / ytcfg |
| 页内 hydration | TikTok | 解析 `__UNIVERSAL_DATA_FOR_REHYDRATION__` |

**可复刻的核心不是「模拟登录表单」，而是：**

1. 接管真实浏览器会话  
2. Cookie 粗检 + 业务级 `verify`  
3. `AuthRequired` 驱动的「打开登录页 → 轮询 → 完成/超时」状态机  
4. 每站只替换探测钩子，不复制状态机  

---

## 10. 代码如何拆解：四层模型

OpenCLI 把 auth 能力缠在 CLI 注册里；迁移时要先切开依赖。

```text
┌──────────────────────────────────────────────────────────┐
│ L0 宿主软件（CLI / GUI / Agent / 服务）                     │
│   命令解析、UI 按钮、输出格式、进程退出码 —— 各软件自建      │
└────────────────────────────▲─────────────────────────────┘
                             │ 调用 whoami() / login()
┌────────────────────────────┴─────────────────────────────┐
│ L1 可移植核心（从 site-auth.js 抽出）                      │
│   runWhoami / runLogin / normalizeIdentity / 超时轮询      │
│   只依赖：AuthRequired / Timeout / AuthPage 接口           │
└────────────────────────────▲─────────────────────────────┘
                             │ 注入 SiteAuthAdapter
┌────────────────────────────┴─────────────────────────────┐
│ L2 站点钩子（从 clis/*/auth.js 复制/改写）                  │
│   quickCheck / verify / poll + site/domain/loginUrl/columns│
│   只依赖：AuthPage + AuthRequired（+ 可选 CommandError）   │
└────────────────────────────▲─────────────────────────────┘
                             │ page 实现
┌────────────────────────────┴─────────────────────────────┐
│ L3 浏览器通道（不要搬 OpenCLI daemon/extension）           │
│   你方：Playwright | Puppeteer | CDP | 自研扩展 | WebView  │
│   适配成 AuthPage：goto / wait / evaluate / getCookies     │
└──────────────────────────────────────────────────────────┘
```

### 10.1 直接可搬 vs 必须替换 vs 不要搬

| 代码 | 处置 |
|------|------|
| `site-auth.js` 里的 `tryProbe` / login while 循环 / `normalizeIdentity` | **直接搬** → 改成纯函数 `runWhoami` / `runLogin` |
| `AuthRequiredError`、`TimeoutError` 语义（`code` + 可识别 instanceof） | **搬精简版**（几十行） |
| 各站 `auth.js` 的 Cookie 名、URL、evaluate 字符串 | **按站搬**（业务资产） |
| `page.getCookies` / `goto` / `wait` / `evaluate` | **只搬接口**，实现对接你的浏览器栈 |
| `cli({...})`、`Strategy.COOKIE`、`registry`、`commander` | **丢弃** |
| `authStatus.quickCheck` 挂到 registry 供 `opencli auth status` | **可选**：你要批量巡检再自己挂 |
| `defaultWindowMode` / `siteSession` / `navigateBefore` | **语义保留、实现自建**（前台、持久会话、禁止预导航） |
| `extension/`、`daemon.ts`、`BrowserBridge` | **不搬**，用你已有通道 |

### 10.2 从 `registerSiteAuthCommands` 拆出纯逻辑

OpenCLI 现状是「注册时把逻辑封进 `func`」。迁移时应拆成：

```text
registerSiteAuthCommands(config)     ← OpenCLI 专用：写 registry
        │
        ├── buildAuthAdapter(config) ← 可移植：得到 SiteAuthAdapter
        ├── runWhoami(adapter, page)
        └── runLogin(adapter, page, { timeout })
```

`site-auth.js` 中真正跨软件的部分只有这些（约 40 行有效逻辑）：

1. `normalizeIdentity(site, row)` → `{ logged_in: true, site, ...row }`
2. `isAuthRequired(error)` → 仅认 `AUTH_REQUIRED`
3. `tryProbe` → `poll` 优先于 `verify`（login 轮询阶段）
4. login：先 identity probe → 失败则 `goto(loginUrl)` → 每 2s poll → 成功或 `Timeout`
5. whoami：只跑 identity probe

`cli()` 调用、`columns` 拼装、`authStatus` 元数据 —— 全部留给宿主。

### 10.3 最小 `AuthPage` 端口（宿主必须实现）

站点钩子实际只用到 4 个方法（对照 `src/types.ts` 的 `IPage`）：

```ts
interface AuthPage {
  goto(url: string): Promise<void>;
  wait(seconds: number): Promise<void>;
  /** 在页面上下文执行；字符串或函数均可，迁移时建议统一字符串以避开序列化差异 */
  evaluate<T = unknown>(script: string): Promise<T>;
  getCookies(opts: { url?: string; domain?: string }): Promise<Array<{ name: string; value: string }>>;
}
```

对接示例：

| 你的栈 | 映射 |
|--------|------|
| Playwright | `page.goto` / `page.waitForTimeout` / `page.evaluate` / `context.cookies` |
| Puppeteer | 同上 |
| CDP 直连 | `Page.navigate` / sleep / `Runtime.evaluate` / `Network.getCookies` |
| OpenCLI Bridge | 已有 `IPage`，可直接当 `AuthPage` |
| Electron webview | 对应 executeJavaScript + session.cookies |

注意：`evaluate` 内的 `fetch(..., credentials: 'include')` **必须在页面 Origin 下跑**，不能改成宿主进程直连 HTTP（会丢 Cookie / 触发 CORS）。

### 10.4 错误契约（必须原样保留语义）

```ts
class AuthRequiredError extends Error {
  code = 'AUTH_REQUIRED';
  constructor(public domain: string, message?: string) {
    super(message ?? `Not logged in to ${domain}`);
  }
}
class AuthTimeoutError extends Error {
  code = 'TIMEOUT';
  constructor(label: string, seconds: number, public hint?: string) {
    super(`${label} timed out after ${seconds}s`);
  }
}
```

| 错误 | whoami | login 轮询中 |
|------|--------|----------------|
| `AUTH_REQUIRED` | 返回「未登录」 | **继续等**（用户还在扫码） |
| `TIMEOUT` | — | 登录失败，提示加长 timeout |
| 其它（CDP 超时、HTTP 5xx、选择器丢） | 探测失败 | **立刻失败**，不要当未登录 |

这是拆解时最容易弄错的一点：若把所有异常都当成「还在登录」，会掩盖桥接故障；若把 CDP timeout 当成 `AUTH_REQUIRED`，会出现「whoami 说挂了、login 又 already_logged_in」的混乱。

### 10.5 会话 / 窗口语义（逻辑迁、实现换）

| OpenCLI 字段 | 迁移时保留的产品语义 | 你软件里怎么做 |
|--------------|----------------------|----------------|
| `navigateBefore: false` | auth 自己控制 URL，框架别预跳 | 调用 whoami/login 前不要自动打开 homepage |
| `siteSession: persistent` | 登录过程保持同一浏览器上下文 | 固定同一个 BrowserContext / Profile / tab lease |
| `defaultWindowMode: foreground`（仅 login） | 用户看得见登录页 | login 时 `bringToFront` / 显示窗口；whoami 可后台 |
| `Strategy.COOKIE` | 依赖浏览器 Cookie，非 OAuth token 文件 | 文档写清：需用户浏览器已登录或完成 login |

---

## 11. 推荐迁移包结构

```text
your-app/
  auth/
    core/
      errors.ts          # AuthRequired / Timeout
      types.ts           # AuthPage, SiteAuthAdapter, WhoamiResult, LoginResult
      run-whoami.ts      # 纯函数
      run-login.ts       # 纯函数（状态机）
      normalize.ts       # normalizeIdentity / isAuthRequired
    adapters/
      xiaohongshu.ts     # 从 clis/xiaohongshu/auth.js 抽出钩子
      facebook.ts
      instagram.ts
      tiktok.ts
      youtube.ts
      twitter.ts
      linkedin.ts
      index.ts           # Map<site, SiteAuthAdapter>
    browser/
      playwright-page.ts # AuthPage 适配器（示例）
      cdp-page.ts
    host/                # 可选：接你的 CLI/GUI
      commands.ts        # 解析 argv → runWhoami/runLogin → 打印
```

单测策略（对齐 `site-auth.test.js`）：

1. Mock `AuthPage`（`goto`/`wait` 可断言）  
2. `verify` 一次成功 → login 返回 `already_logged_in`，且 **未** `goto(loginUrl)`  
3. 先 `AUTH_REQUIRED` 再成功 → `login_complete`，断言打开了 loginUrl  
4. 一直 `AUTH_REQUIRED` → `TIMEOUT`  
5. poll 抛非 Auth 错误 → 立即失败  

---

## 12. 可粘贴的可移植核心（迁移模板）

以下是从 `site-auth.js` 剥离 registry 后的等价实现，可直接放进你的仓库再改 import。

```ts
// auth/core/types.ts
export interface AuthPage {
  goto(url: string): Promise<void>;
  wait(seconds: number): Promise<void>;
  evaluate<T = unknown>(script: string): Promise<T>;
  getCookies(opts?: { url?: string; domain?: string }): Promise<Array<{ name: string; value: string }>>;
}

export interface SiteAuthAdapter {
  site: string;
  domain: string;
  loginUrl: string;
  columns?: string[];
  quickCheck?(page: AuthPage): Promise<boolean | { logged_in: boolean }>;
  verify(page: AuthPage): Promise<Record<string, unknown>>;
  poll?(page: AuthPage): Promise<Record<string, unknown>>;
}

export type WhoamiResult = { logged_in: true; site: string } & Record<string, unknown>;
export type LoginResult =
  | ({ status: 'already_logged_in' } & WhoamiResult)
  | ({ status: 'login_complete' } & WhoamiResult);
```

```ts
// auth/core/run.ts
const DEFAULT_TIMEOUT_SECONDS = 300;
const POLL_INTERVAL_MS = 2000;

function normalizeIdentity(site: string, identity: unknown): WhoamiResult {
  const row = identity && typeof identity === 'object' && !Array.isArray(identity)
    ? (identity as Record<string, unknown>)
    : {};
  return { logged_in: true, site, ...row };
}

function isAuthRequired(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { code?: string }).code === 'AUTH_REQUIRED');
}

async function probe(adapter: SiteAuthAdapter, page: AuthPage, phase: 'identity' | 'poll') {
  const fn = phase === 'poll' && adapter.poll ? adapter.poll : adapter.verify;
  return normalizeIdentity(adapter.site, await fn(page));
}

export async function runWhoami(adapter: SiteAuthAdapter, page: AuthPage): Promise<WhoamiResult> {
  return probe(adapter, page, 'identity');
}

export async function runLogin(
  adapter: SiteAuthAdapter,
  page: AuthPage,
  opts: { timeoutSeconds?: number } = {},
): Promise<LoginResult> {
  try {
    return { status: 'already_logged_in', ...(await probe(adapter, page, 'identity')) };
  } catch (error) {
    if (!isAuthRequired(error)) throw error;
  }

  await page.goto(adapter.loginUrl);
  const timeoutSeconds = opts.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
  const deadline = Date.now() + timeoutSeconds * 1000;
  let lastAuthMessage = '';

  while (Date.now() < deadline) {
    const remain = Math.max(0.2, (deadline - Date.now()) / 1000);
    await page.wait(Math.min(POLL_INTERVAL_MS / 1000, remain));
    try {
      return { status: 'login_complete', ...(await probe(adapter, page, 'poll')) };
    } catch (error) {
      if (!isAuthRequired(error)) throw error;
      lastAuthMessage = error instanceof Error ? error.message : String(error);
    }
  }

  throw new AuthTimeoutError(
    `${adapter.site} login`,
    timeoutSeconds,
    lastAuthMessage
      ? `Open ${adapter.loginUrl} and retry. Last auth check: ${lastAuthMessage}`
      : `Open ${adapter.loginUrl} and complete login, then retry.`,
  );
}
```

站点文件迁移套路（以 Instagram 为例）：

```ts
// auth/adapters/instagram.ts
import { AuthRequiredError } from '../core/errors';
import type { AuthPage, SiteAuthAdapter } from '../core/types';

async function hasSession(page: AuthPage) {
  const cookies = await page.getCookies({ url: 'https://www.instagram.com' });
  return cookies.some(c => c.name === 'sessionid' && c.value);
}

async function verify(page: AuthPage) {
  // 原样搬 evaluate 字符串与抛错分支（见 clis/instagram/auth.js）
  ...
}

export const instagramAuth: SiteAuthAdapter = {
  site: 'instagram',
  domain: 'instagram.com',
  loginUrl: 'https://www.instagram.com/accounts/login/',
  columns: ['user_id', 'username', 'full_name'],
  quickCheck: hasSession,
  verify,
  poll: async (page) => {
    if (!await hasSession(page)) {
      throw new AuthRequiredError('www.instagram.com', 'Waiting for Instagram sessionid cookie');
    }
    return verify(page);
  },
};
```

宿主接线（伪代码）：

```ts
const page = await yourBrowser.connectAsAuthPage({ profile, foreground: command === 'login' });
const adapter = adapters[site];
const result = command === 'whoami'
  ? await runWhoami(adapter, page)
  : await runLogin(adapter, page, { timeoutSeconds });
print(result); // table / json / yaml 由宿主决定
```

---

## 13. 分步迁移清单

1. **实现 `AuthPage`**  
   用现有浏览器自动化跑通：`getCookies` 读到某站会话 Cookie。

2. **落地 `runWhoami` / `runLogin` + 错误类型**  
   用 mock page 跑通 `site-auth.test.js` 同款用例。

3. **先迁 1 个站点钩子**（建议 Facebook：逻辑短，或 Twitter：DOM 清晰）  
   真机：`whoami` → 未登录 `login` → 再 `whoami`。

4. **批量迁 `clis/*/auth.js`**  
   去掉 `registerSiteAuthCommands`，改导出 `SiteAuthAdapter`；`evaluate` 字符串尽量原样保留。

5. **补宿主体验**  
   login 前台、whoami 可后台、timeout 参数、结构化输出、doctor。

6. **（可选）批量 status**  
   对所有 adapter 调 `quickCheck`，不要默认跑满 `verify`（贵且易超时）。

7. **不要做的事**  
   - 不要在 Node 里用拷出来的 Cookie 调需浏览器指纹的接口当「已登录」（和 OpenCLI 模型不一致，且易风控）  
   - 不要把 Bridge/daemon 整包拷进无关产品  
   - 不要让站点钩子依赖 `cli` / `registry` / `commander`

---

## 14. 风险与维护

| 风险 | 说明 | 缓解 |
|------|------|------|
| 站点改版 | API 路径、DOM testid、hydration 结构会变 | 钩子按站隔离；失败码区分 AUTH vs SELECTOR/HTTP |
| evaluate 超时 | 如小红书 whoami CDP 30s | 导航/evaluate 独立超时；重试；勿映射成 AUTH_REQUIRED |
| Cookie 名变更 | quickCheck 假阴性/假阳性 | verify 仍以业务 API/DOM 为准；Cookie 只做加速 |
| 多 Profile | 登错账号 | AuthPage 绑定明确 profile/context |
| 合规 | 自动化登录可能触 ToS | 产品侧约束：只复用用户本机会话、不存密码 |

---

## 15. 源码索引

```text
# 可移植核心（逻辑来源）
clis/_shared/site-auth.js          # 状态机（迁时去掉 cli()）
clis/_shared/site-auth.test.js     # already_logged_in / login_complete / timeout
src/errors.ts                      # AuthRequiredError / TimeoutError
src/types.ts                       # IPage：goto / wait / evaluate / getCookies

# 站点钩子（整文件可改编为 SiteAuthAdapter）
clis/xiaohongshu/auth.js
clis/facebook/auth.js
clis/instagram/auth.js
clis/tiktok/auth.js
clis/youtube/auth.js
clis/twitter/auth.js
clis/linkedin/auth.js

# OpenCLI 宿主专用（通常不迁）
src/registry.ts / src/cli.ts
src/commands/auth.ts               # 跨站 auth status
src/browser/* / extension/ / daemon.ts
```

本地验证：

```bash
opencli doctor
opencli xiaohongshu whoami -f yaml
opencli xiaohongshu login -f yaml
opencli facebook whoami -f yaml
opencli facebook login --timeout 300 -f yaml
opencli instagram whoami -f yaml
opencli twitter whoami -f yaml
opencli linkedin whoami -f yaml
opencli youtube whoami -f yaml
opencli tiktok whoami -f yaml
# 失败时保留痕迹
opencli xiaohongshu whoami --trace retain-on-failure
```
