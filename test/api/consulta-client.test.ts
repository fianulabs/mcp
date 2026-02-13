import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConsultaClient } from '../../src/api/consulta-client';
import type { Env, SessionState } from '../../src/types';

// Mock environment
const createMockEnv = (): Env => ({
  COMPLIANCE_MCP: {} as any,
  CACHE_KV: {
    get: vi.fn(),
    put: vi.fn(),
  } as any,
  ANALYTICS: {
    writeDataPoint: vi.fn(),
  } as any,
  ENVIRONMENT: 'test',
  CONSULTA_URL: 'https://fianu-dev.fianu.io/api',
  AUTH0_DOMAIN: 'auth.fianu.io',
  AUTH0_ISSUER: 'https://auth.fianu.io/',
  AUTH0_CLIENT_ID: 'test-client-id',
  AUTH0_CLIENT_SECRET: 'test-client-secret',
  MCP_SERVER_NAME: 'Test MCP',
  MCP_SERVER_VERSION: '0.1.0',
});

// Mock session state
const createMockSession = (): SessionState => ({
  userId: 'test-user-123',
  tenantId: 'test-tenant-456',
  accessToken: 'test-token',
  tokenExpiry: Date.now() + 3600000,
  sessionStarted: Date.now(),
});

describe('ConsultaClient', () => {
  let env: Env;
  let session: SessionState;
  let client: ConsultaClient;

  beforeEach(() => {
    env = createMockEnv();
    session = createMockSession();
    client = new ConsultaClient(env, session);
    
    // Reset mocks
    vi.clearAllMocks();
  });

  describe('getAssetCompliance', () => {
    it('should fetch asset compliance from Consulta API', async () => {
      const mockResponse = {
        asset: {
          uuid: 'asset-123',
          name: 'my-repo',
          type: 'repository',
          branch: 'main',
        },
        score: 0.85,
        passing: 17,
        failing: 3,
        total: 20,
        lastUpdated: '2025-11-20T10:00:00Z',
        controls: [],
      };

      // Mock fetch
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => mockResponse,
      });

      const result = await client.getAssetCompliance('asset-123', 'repository', 'main');

      expect(result).toEqual(mockResponse);
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/metrics/trends/sunburst/asset'),
        expect.objectContaining({
          headers: expect.objectContaining({
            'Authorization': 'Bearer test-token',
            'X-Tenant-ID': 'test-tenant-456',
          }),
        })
      );
    });

    it('should return cached data if available', async () => {
      const cachedData = { asset: { name: 'cached' }, score: 0.9 };
      
      vi.mocked(env.CACHE_KV.get).mockResolvedValue(cachedData);

      const result = await client.getAssetCompliance('asset-123');

      expect(result).toEqual(cachedData);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('should log API calls to Analytics Engine', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ asset: {}, score: 0 }),
      });

      await client.getAssetCompliance('asset-123');

      expect(env.ANALYTICS.writeDataPoint).toHaveBeenCalledWith(
        expect.objectContaining({
          blobs: [
            'consulta_api_call',
            expect.any(String),
            'test-user-123',
            'test-tenant-456',
          ],
          indexes: ['200', 'success', expect.any(String)],
        })
      );
    });

    it('should log security events on 403 responses', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        statusText: 'Forbidden',
        text: async () => 'Access denied',
      });

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await expect(client.getAssetCompliance('asset-123')).rejects.toThrow();

      expect(consoleSpy).toHaveBeenCalledWith(
        'SECURITY: Tenant access denied',
        expect.objectContaining({
          userId: 'test-user-123',
          tenantId: 'test-tenant-456',
          status: 403,
        })
      );

      consoleSpy.mockRestore();
    });
  });

  describe('listControls', () => {
    it('should fetch controls with filters', async () => {
      const mockControls = [
        { uuid: 'ctrl-1', name: 'Control 1', severity: 'high', framework: 'SLSA' },
        { uuid: 'ctrl-2', name: 'Control 2', severity: 'critical', framework: 'SLSA' },
      ];

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => mockControls,
      });

      const result = await client.listControls('SLSA', 'high');

      expect(result).toEqual(mockControls);
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/controls?framework=SLSA&severity=high'),
        expect.any(Object)
      );
    });
  });

  describe('getComplianceSummary', () => {
    it('should fetch organization-wide summary', async () => {
      const mockSummary = {
        tenant: { id: 'test-tenant-456', name: 'Test Org' },
        overallScore: 0.82,
        totalAssets: 50,
        compliantAssets: 41,
        nonCompliantAssets: 9,
        criticalIssues: 2,
        highIssues: 7,
        frameworks: [],
        lastUpdated: '2025-11-20T10:00:00Z',
      };

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => mockSummary,
      });

      const result = await client.getComplianceSummary();

      expect(result).toEqual(mockSummary);
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/metrics/summary'),
        expect.any(Object)
      );
    });
  });

  describe('tenant isolation', () => {
    it('should always include X-Tenant-ID header from session', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({}),
      });

      await client.getComplianceSummary();

      const fetchCall = vi.mocked(global.fetch).mock.calls[0];
      const headers = (fetchCall[1] as any).headers;

      expect(headers['X-Tenant-ID']).toBe('test-tenant-456');
    });

    it('should include access token in Authorization header', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({}),
      });

      await client.getComplianceSummary();

      const fetchCall = vi.mocked(global.fetch).mock.calls[0];
      const headers = (fetchCall[1] as any).headers;

      expect(headers['Authorization']).toBe('Bearer test-token');
    });
  });
});

