import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const FIXTURES = join(__dirname, '../../src/adapters/zernio/fixtures');

export function fixture<T = Record<string, unknown>>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as T;
}

export function fixtureRaw(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf8');
}

export interface Call {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: unknown;
  rawBody: unknown;
}

export type Handler = (call: Call) => Response | undefined;

export function json(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** fetch falso: primeiro handler que devolver Response vence; sem handler, 404. */
export function mockFetch(handlers: Handler[], calls: Call[] = []): typeof globalThis.fetch {
  return async (input, init) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    const rawBody = init?.body;
    let body: unknown;
    if (typeof rawBody === 'string') {
      try {
        body = JSON.parse(rawBody);
      } catch {
        body = rawBody;
      }
    }
    const call: Call = {
      method: (init?.method ?? 'GET').toUpperCase(),
      url: new URL(String(input)),
      headers,
      body,
      rawBody,
    };
    calls.push(call);
    for (const handler of handlers) {
      const response = handler(call);
      if (response) return response;
    }
    return json(404, { error: 'sem rota no mock', type: 'not_found', code: 'not_found' });
  };
}

export const CONVERSATION_ID = 'cnv00000000000000000001';
export const CHAT_ID = '15550100001';

export const route =
  (method: string, pathPart: string, respond: (call: Call) => Response): Handler =>
  (call) =>
    call.method === method && call.url.pathname.includes(pathPart) ? respond(call) : undefined;

/** Rotas felizes do Zernio para os testes de envio. */
export function happyRoutes(): Handler[] {
  return [
    route('GET', '/v1/inbox/conversations/search', () =>
      json(200, {
        data: [
          {
            conversation: { id: CONVERSATION_ID, participantId: CHAT_ID, platform: 'whatsapp' },
            matchCount: 0,
            matches: [],
          },
        ],
      }),
    ),
    route('POST', '/reactions', () =>
      json(200, { success: true, messageId: 'm1', platformMessageId: 'wamid.FIXTURE0002' }),
    ),
    route('DELETE', '/reactions', () =>
      json(200, { success: true, messageId: 'm1', platformMessageId: 'wamid.FIXTURE0002' }),
    ),
    route('POST', '/messages', () => json(200, fixture('rest-send-message-200.json'))),
    route('POST', '/v1/inbox/conversations', () =>
      json(201, fixture('rest-open-conversation-template-201.json')),
    ),
    route('PUT', '/v1/inbox/conversations/', () => json(200, { success: true })),
    route('POST', '/read', () => json(200, { success: true, markedCount: 1 })),
    route('POST', '/typing', () => json(200, { success: true })),
    route(
      'GET',
      '/v1/whatsapp/media/',
      () =>
        new Response(Buffer.from('conteudo-fake'), {
          status: 200,
          headers: { 'content-type': 'image/jpeg' },
        }),
    ),
    route('GET', '/v1/whatsapp/number-info', () => json(200, fixture('rest-number-info-200.json'))),
  ];
}
