import type { HttpBindings } from '@hono/node-server';
import type { AuthSession } from './auth.js';
import type { UserRow } from './domain/types.js';

export type AppEnv = {
  Bindings: Partial<HttpBindings>;
  Variables: {
    user: UserRow | undefined;
    session: AuthSession | undefined;
    clientIp: string;
  };
};
