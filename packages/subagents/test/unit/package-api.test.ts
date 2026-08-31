import { describe, expect, it } from 'vitest';
import * as rootApi from '../../src/index.js';
import * as documentApi from '@mpx/subagents/documents';

describe('@mpx/subagents package API', () => {
  it('exposes agent documents only through the narrow documents subpath', () => {
    expect(Object.keys(documentApi).sort()).toEqual([
      'AgentDocumentError',
      'loadCanonicalAgentProjectionInputsV1',
      'renderCanonicalAgentDocumentV1',
    ]);
    expect(rootApi).not.toHaveProperty('AgentDocumentError');
    expect(rootApi).not.toHaveProperty('loadCanonicalAgentProjectionInputsV1');
    expect(rootApi).not.toHaveProperty('renderCanonicalAgentDocumentV1');
  });
});
