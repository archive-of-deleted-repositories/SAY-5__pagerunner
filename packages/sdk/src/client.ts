import type {
  CreateFlowRequest,
  CreateRunRequest,
  Flow,
  Run,
  RunDetail,
  RunList,
  RunStatus,
} from './types.js';

export interface ClientOptions {
  baseUrl: string;
  apiKey?: string;
  fetch?: typeof fetch;
}

export class PageRunnerClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: ClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    if (opts.apiKey !== undefined) this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json', ...extra };
    if (this.apiKey) h.authorization = `Bearer ${this.apiKey}`;
    return h;
  }

  private async req<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers: { ...this.headers(), ...((init.headers as Record<string, string>) ?? {}) },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`HTTP ${res.status} ${path}: ${body}`);
    }
    return (await res.json()) as T;
  }

  createFlow(req: CreateFlowRequest): Promise<Flow> {
    return this.req<Flow>('/flows', { method: 'POST', body: JSON.stringify(req) });
  }

  getFlow(id: string): Promise<Flow> {
    return this.req<Flow>(`/flows/${encodeURIComponent(id)}`);
  }

  createRun(req: CreateRunRequest): Promise<Run> {
    const headers: Record<string, string> = {};
    if (req.idempotencyKey) headers['idempotency-key'] = req.idempotencyKey;
    return this.req<Run>('/runs', {
      method: 'POST',
      headers,
      body: JSON.stringify({ flowId: req.flowId, inputs: req.inputs ?? {} }),
    });
  }

  listRuns(opts: { status?: RunStatus; cursor?: string; limit?: number } = {}): Promise<RunList> {
    const params = new URLSearchParams();
    if (opts.status) params.set('status', opts.status);
    if (opts.cursor) params.set('cursor', opts.cursor);
    if (opts.limit) params.set('limit', String(opts.limit));
    const qs = params.toString();
    return this.req<RunList>(`/runs${qs ? `?${qs}` : ''}`);
  }

  getRun(id: string): Promise<RunDetail> {
    return this.req<RunDetail>(`/runs/${encodeURIComponent(id)}`);
  }

  cancelRun(id: string): Promise<{ ok: true }> {
    return this.req<{ ok: true }>(`/runs/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
  }

  getArtifactUrl(runId: string, stepIdx: number): Promise<{ url: string; expiresAt: string }> {
    return this.req<{ url: string; expiresAt: string }>(
      `/artifacts/${encodeURIComponent(runId)}/${stepIdx}`,
    );
  }
}
