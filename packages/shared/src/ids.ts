import { randomUUID, randomBytes } from 'node:crypto';

export const newRunId = (): string => `run_${shortUlid()}`;
export const newFlowId = (): string => `flow_${shortUlid()}`;
export const newTenantId = (): string => `tn_${shortUlid()}`;
export const newTraceId = (): string => randomUUID();

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function shortUlid(): string {
  const time = Date.now();
  const timeChars: string[] = [];
  let t = time;
  for (let i = 0; i < 10; i++) {
    timeChars.unshift(ALPHABET[t % 32] ?? '0');
    t = Math.floor(t / 32);
  }
  const rand = randomBytes(8);
  const randChars: string[] = [];
  for (let i = 0; i < 8; i++) {
    const byte = rand[i];
    if (byte === undefined) continue;
    randChars.push(ALPHABET[byte % 32] ?? '0');
  }
  return timeChars.join('') + randChars.join('');
}
