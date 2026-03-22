/* tests/resourceHandlers.test.ts */

import { describe, it, expect, beforeEach, mock } from 'bun:test';
// import { McpServer } from '@modelcontextprotocol/sdk';
import { registerResources } from '../src/lib/resourceHandlers';
import type { capellaConn } from '../src/types';

describe('Resource Handlers', () => {
  let mockServer: any;
  let mockCapellaConn: capellaConn;

  beforeEach(() => {
    mockServer = {
      tool: mock(() => {})
    };

    mockCapellaConn = {
      defaultBucket: {
        scope: () => ({
          collection: () => ({
            get: () => Promise.resolve({ content: { test: 'data' } })
          })
        }),
        collections: () => ({
          getAllScopes: () => Promise.resolve([
            {
              name: '_default',
              collections: [{ name: '_default' }]
            }
          ])
        })
      }
    } as any;
  });

  describe('Resource Handlers', () => {
    it('should register server info tool', () => {
      registerResources(mockServer as unknown as McpServer, mockCapellaConn);
      
      expect(mockServer.tool).toHaveBeenCalledWith(
        'get_server_info',
        'Get server information',
        {},
        expect.any(Function)
      );
    });

    it('should register document tool', () => {
      registerResources(mockServer as unknown as McpServer, mockCapellaConn);
      
      expect(mockServer.tool).toHaveBeenCalledWith(
        'get_document_by_path',
        'Get a document by its path',
        expect.any(Object),
        expect.any(Function)
      );
    });

    it('should register bucket info tool', () => {
      registerResources(mockServer as unknown as McpServer, mockCapellaConn);
      
      expect(mockServer.tool).toHaveBeenCalledWith(
        'get_bucket_info',
        'Get bucket information',
        expect.any(Object),
        expect.any(Function)
      );
    });
  });
}); 