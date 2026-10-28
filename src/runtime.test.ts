import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserBridge, CDPBridge } from './browser/index.js';
import { applyCdpEndpointFromCli, getBrowserFactory, getConfiguredCdpEndpoint } from './runtime.js';

describe('getBrowserFactory', () => {
  const previousEndpoint = process.env.OPENCLI_CDP_ENDPOINT;

  beforeEach(() => {
    delete process.env.OPENCLI_CDP_ENDPOINT;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    if (previousEndpoint === undefined) delete process.env.OPENCLI_CDP_ENDPOINT;
    else process.env.OPENCLI_CDP_ENDPOINT = previousEndpoint;
  });

  it('uses BrowserBridge for regular sites by default', () => {
    expect(getBrowserFactory()).toBe(BrowserBridge);
  });

  it('uses CDPBridge when OPENCLI_CDP_ENDPOINT is configured', () => {
    vi.stubEnv('OPENCLI_CDP_ENDPOINT', 'http://127.0.0.1:9333');

    expect(getBrowserFactory()).toBe(CDPBridge);
  });

  it('lets --cdp-endpoint override the process env for this run', () => {
    process.env.OPENCLI_CDP_ENDPOINT = 'http://127.0.0.1:1111';
    applyCdpEndpointFromCli('http://127.0.0.1:9222');
    expect(getConfiguredCdpEndpoint()).toBe('http://127.0.0.1:9222');
    expect(getBrowserFactory()).toBe(CDPBridge);
  });
});
