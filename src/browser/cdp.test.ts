import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const { MockWebSocket } = vi.hoisted(() => {
  class MockWebSocket {
    static OPEN = 1;
    static lastInstance: MockWebSocket | undefined;
    static urls: string[] = [];
    readyState = 1;
    private handlers = new Map<string, Array<(...args: unknown[]) => void>>();

    constructor(url: string) {
      MockWebSocket.lastInstance = this;
      MockWebSocket.urls.push(url);
      queueMicrotask(() => this.emit('open'));
    }

    on(event: string, handler: (...args: unknown[]) => void): void {
      const handlers = this.handlers.get(event) ?? [];
      handlers.push(handler);
      this.handlers.set(event, handlers);
    }

    send(_message: string): void {}

    close(): void {
      this.readyState = 3;
    }

    emit(event: string, ...args: unknown[]): void {
      for (const handler of this.handlers.get(event) ?? []) {
        handler(...args);
      }
    }
  }

  return { MockWebSocket };
});

vi.mock('ws', () => ({
  WebSocket: MockWebSocket,
}));

import { CDPBridge, CDP_REQUEST_BODY_CAPTURE_LIMIT } from './cdp.js';

describe('CDPBridge cookies', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    MockWebSocket.urls = [];
  });

  it('filters cookies by actual domain match instead of substring match', async () => {
    vi.stubEnv('OPENCLI_CDP_ENDPOINT', 'ws://127.0.0.1:9222/devtools/page/1');

    const bridge = new CDPBridge();
    vi.spyOn(bridge, 'send').mockResolvedValue({
      cookies: [
        { name: 'good', value: '1', domain: '.example.com' },
        { name: 'exact', value: '2', domain: 'example.com' },
        { name: 'bad', value: '3', domain: 'notexample.com' },
      ],
    });

    const page = await bridge.connect();
    const cookies = await page.getCookies({ domain: 'example.com' });

    expect(cookies).toEqual([
      { name: 'good', value: '1', domain: '.example.com' },
      { name: 'exact', value: '2', domain: 'example.com' },
    ]);
  });

  it('exposes native input helpers on direct CDP pages', async () => {
    vi.stubEnv('OPENCLI_CDP_ENDPOINT', 'ws://127.0.0.1:9222/devtools/page/1');

    const bridge = new CDPBridge();
    const send = vi.spyOn(bridge, 'send').mockResolvedValue({});

    const page = await bridge.connect();
    send.mockClear();

    expect(page.nativeType).toBeTypeOf('function');
    expect(page.nativeKeyPress).toBeTypeOf('function');
    expect(page.nativeClick).toBeTypeOf('function');
    expect(page.handleJavaScriptDialog).toBeTypeOf('function');
    expect(page.cdp).toBeTypeOf('function');

    await page.nativeType!('hello');
    await page.nativeKeyPress!('a', ['Ctrl']);
    await page.nativeClick!(10, 20);
    await page.handleJavaScriptDialog!(true, 'ok');
    await page.cdp!('Page.getLayoutMetrics', {});

    expect(send.mock.calls).toEqual([
      ['Input.insertText', { text: 'hello' }],
      ['Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', modifiers: 2 }],
      ['Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', modifiers: 2 }],
      ['Input.dispatchMouseEvent', { type: 'mouseMoved', x: 10, y: 20 }],
      ['Input.dispatchMouseEvent', { type: 'mousePressed', x: 10, y: 20, button: 'left', clickCount: 1 }],
      ['Input.dispatchMouseEvent', { type: 'mouseReleased', x: 10, y: 20, button: 'left', clickCount: 1 }],
      ['Page.handleJavaScriptDialog', { accept: true, promptText: 'ok' }],
      ['Page.getLayoutMetrics', {}],
    ]);
  });

  it('captures request headers and bounded post data on direct CDP pages', async () => {
    vi.stubEnv('OPENCLI_CDP_ENDPOINT', 'ws://127.0.0.1:9222/devtools/page/1');

    const bridge = new CDPBridge();
    const fullBody = 'x'.repeat(CDP_REQUEST_BODY_CAPTURE_LIMIT + 5);
    vi.spyOn(bridge, 'send').mockImplementation(async (method: string) => {
      if (method === 'Network.getRequestPostData') return { postData: fullBody };
      return {};
    });

    const page = await bridge.connect();
    await page.startNetworkCapture?.();
    MockWebSocket.lastInstance?.emit('message', Buffer.from(JSON.stringify({
      method: 'Network.requestWillBeSent',
      params: {
        requestId: 'request-1',
        request: {
          method: 'POST',
          url: 'https://example.test/rsc-action/actions/pagination',
          headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
          hasPostData: true,
        },
      },
    })));

    const entries = await page.readNetworkCapture?.() as Array<Record<string, unknown>>;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      method: 'POST',
      requestHeaders: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
      requestBodyKind: 'string',
      requestBodyFullSize: fullBody.length,
      requestBodyTruncated: true,
    });
    expect(String(entries[0].requestBodyPreview)).toHaveLength(CDP_REQUEST_BODY_CAPTURE_LIMIT);
  });
});

describe('CDPBridge tab APIs via /json', () => {
  let server: Server;
  let baseUrl: string;
  let targets: Array<{ id: string; type: string; url: string; title: string; webSocketDebuggerUrl: string }>;
  let putNewCalls: string[];

  beforeEach(async () => {
    vi.unstubAllEnvs();
    MockWebSocket.urls = [];
    putNewCalls = [];
    targets = [
      {
        id: 'tab-home',
        type: 'page',
        url: 'https://x.com/home',
        title: 'Home / X',
        webSocketDebuggerUrl: 'ws://127.0.0.1:9/devtools/page/tab-home',
      },
    ];

    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname === '/json') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(targets));
        return;
      }
      if (url.pathname === '/json/new') {
        putNewCalls.push(req.method ?? '');
        if (req.method !== 'PUT' && req.method !== 'GET') {
          res.writeHead(405);
          res.end('method');
          return;
        }
        const created = {
          id: 'tab-yt',
          type: 'page',
          url: decodeURIComponent(url.search.slice(1) || 'about:blank'),
          title: 'YouTube Studio',
          webSocketDebuggerUrl: 'ws://127.0.0.1:9/devtools/page/tab-yt',
        };
        targets.push(created);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(created));
        return;
      }
      if (url.pathname.startsWith('/json/activate/')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify('Target is activating'));
        return;
      }
      if (url.pathname.startsWith('/json/close/')) {
        const id = decodeURIComponent(url.pathname.slice('/json/close/'.length));
        targets = targets.filter(t => t.id !== id);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify('Target is closing'));
        return;
      }
      res.writeHead(404);
      res.end('missing');
    });

    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
    vi.stubEnv('OPENCLI_CDP_ENDPOINT', baseUrl);
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve())));
    vi.unstubAllEnvs();
  });

  it('opens, selects, and closes a tab without navigating the original target', async () => {
    const bridge = new CDPBridge();
    vi.spyOn(bridge, 'send').mockResolvedValue({});
    const page = await bridge.connect();

    expect(bridge.targetId).toBe('tab-home');
    expect(MockWebSocket.urls.at(-1)).toContain('tab-home');

    const created = await page.newTab?.('https://studio.youtube.com');
    expect(created).toBe('tab-yt');
    expect(putNewCalls[0]).toBe('PUT');
    // Bridge semantics: newTab does not adopt — still on home until selectTab.
    expect(bridge.targetId).toBe('tab-home');

    await page.selectTab(created!);
    expect(bridge.targetId).toBe('tab-yt');
    expect(MockWebSocket.urls.at(-1)).toContain('tab-yt');

    await page.closeTab?.(created!);
    expect(bridge.targetId).toBe('tab-home');
    expect(targets.map(t => t.id)).toEqual(['tab-home']);
    expect(MockWebSocket.urls.at(-1)).toContain('tab-home');
  });
});
