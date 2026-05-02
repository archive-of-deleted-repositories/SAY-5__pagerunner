/* eslint-disable @typescript-eslint/no-require-imports */
type Run = {
  id: string;
  flowId: string;
  status: string;
  costUsd: string;
  startedAt?: string | null;
};

async function loadRuns(): Promise<Run[]> {
  const base = process.env['CONTROL_PLANE_URL'] ?? 'http://localhost:3000';
  try {
    const res = await fetch(`${base}/runs?limit=20`, { cache: 'no-store' });
    if (!res.ok) return [];
    const body = (await res.json()) as { runs: Run[] };
    return body.runs;
  } catch {
    return [];
  }
}

export default async function Page(): Promise<JSX.Element> {
  const runs = await loadRuns();
  return (
    <main style={{ fontFamily: 'system-ui', padding: 24, maxWidth: 960, margin: '0 auto' }}>
      <h1 style={{ fontSize: 24, marginBottom: 16 }}>PageRunner</h1>
      <p style={{ color: '#555', marginBottom: 24 }}>Recent runs</p>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
        <thead>
          <tr style={{ textAlign: 'left', borderBottom: '1px solid #ddd' }}>
            <th style={{ padding: 8 }}>id</th>
            <th style={{ padding: 8 }}>flow</th>
            <th style={{ padding: 8 }}>status</th>
            <th style={{ padding: 8 }}>cost</th>
            <th style={{ padding: 8 }}>started</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.id} style={{ borderBottom: '1px solid #f0f0f0' }}>
              <td style={{ padding: 8, fontFamily: 'monospace' }}>{r.id}</td>
              <td style={{ padding: 8 }}>{r.flowId}</td>
              <td style={{ padding: 8 }}>{r.status}</td>
              <td style={{ padding: 8 }}>${r.costUsd}</td>
              <td style={{ padding: 8 }}>{r.startedAt ?? '—'}</td>
            </tr>
          ))}
          {runs.length === 0 && (
            <tr>
              <td colSpan={5} style={{ padding: 16, color: '#777' }}>
                No runs found. Start the control-plane and post one.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </main>
  );
}

export const dynamic = 'force-dynamic';
