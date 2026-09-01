import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LaunchDescriptor } from '@mpx/launch';
import { NodePrivateRouteMaterializer } from '../../src/node/private-route-materializer.js';

describe('Node private route materializer', () => {
  it.each(['../work', 'a/b', 'a\\b', '.', '..', 'route%2fescape', 'route\u0000hidden'])(
    'rejects an invalid opaque label before descriptor parsing without disclosing it',
    async (label) => {
      const descriptor = {
        routes: {
          gitAuthor: label,
          providers: {},
          ssh: null,
          mcp: { allow: [], shareNativeAuth: false },
        },
      } as unknown as LaunchDescriptor;

      const error = await new NodePrivateRouteMaterializer(path.resolve('missing-state'))
        .materialize(descriptor)
        .catch((reason) => reason);

      expect(error).toMatchObject({ code: 'PRIVATE_ROUTE_LABEL_INVALID' });
      expect(JSON.stringify(error)).not.toContain(label);
    },
  );
});
