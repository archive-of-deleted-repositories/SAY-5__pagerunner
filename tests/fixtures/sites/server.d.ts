import { type Server } from 'node:http';
export declare const buildServer: () => Server;
export declare const start: (port?: number) => Promise<{
  server: Server;
  port: number;
  url: string;
}>;
export declare const stop: (server: Server) => Promise<void>;
//# sourceMappingURL=server.d.ts.map
