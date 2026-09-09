import { describe, expect, it } from 'vitest';
import * as rootApi from '../../src/index.js';
import * as documentApi from '@mpx/subagents/documents';

describe('@mpx/subagents package API', () => {
  it('exposes agent documents only through the narrow documents subpath', () => {
    expect(Object.keys(documentApi).sort()).toEqual([
      'AgentDocumentError',
      'loadCanonicalAgentProjectionInputs',
      'renderCanonicalAgentDocument',
    ]);
    expect(rootApi).not.toHaveProperty('AgentDocumentError');
    expect(rootApi).not.toHaveProperty('loadCanonicalAgentProjectionInputs');
    expect(rootApi).not.toHaveProperty('renderCanonicalAgentDocument');
  });
});
