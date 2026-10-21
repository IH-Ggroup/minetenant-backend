import type { HttpBindings } from '@hono/node-server';
import type { AuthSession } from './auth.js';
import type { AuthenticatedUserRow } from './domain/types.js';

export type AppEnv = {
  Bindings: Partial<HttpBindings>;
  Variables: {
    user: AuthenticatedUserRow | undefined;
    session: AuthSession | undefined;
    clientIp: string;
  };
};
