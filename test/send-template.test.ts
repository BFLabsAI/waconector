import { describe, expect, it } from 'vitest';
import { createConnector, isWaConnectorError, UnsupportedCapabilityError } from '../src';
import { wuzapi } from '../src/adapters/wuzapi';
import { HttpClient } from '../src/core/http';
import { MockAdapter } from '../src/testing';

describe('messages.sendTemplate (ADR-0022)', () => {
  it('MockAdapter envia template e normaliza o destinatário', async () => {
    const adapter = new MockAdapter();
    adapter.simulateConnected();
    const wa = createConnector(adapter);
    const sent = await wa.messages.sendTemplate({
      to: '+55 85 99999-9999',
      name: 'pedido_confirmado',
      language: 'pt_BR',
      params: ['Ana', 'PED-1'],
    });
    expect(sent.chatId).toBe('5585999999999');
    expect(sent.id).toBeTruthy();
  });

  it('valida name, language e params com INVALID_INPUT', async () => {
    const adapter = new MockAdapter();
    adapter.simulateConnected();
    const wa = createConnector(adapter);
    const bad = [
      { to: '5585999999999', name: '', language: 'pt_BR' },
      { to: '5585999999999', name: 'x', language: ' ' },
      { to: '5585999999999', name: 'x', language: 'pt_BR', params: [1 as unknown as string] },
    ];
    for (const input of bad) {
      const failure = await wa.messages.sendTemplate(input).catch((e: unknown) => e);
      expect(isWaConnectorError(failure) && failure.code === 'INVALID_INPUT').toBe(true);
    }
  });

  it('adapter que não declara a capability devolve UNSUPPORTED_CAPABILITY', async () => {
    const wa = createConnector(wuzapi({ baseUrl: 'https://x.test', token: 't' }));
    const failure = await wa.messages
      .sendTemplate({ to: '5585999999999', name: 'x', language: 'pt_BR' })
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(UnsupportedCapabilityError);
  });
});

describe('HttpClient: corpo do erro do provider', () => {
  it('expõe o corpo JSON do erro em WaConnectorError.body', async () => {
    const http = new HttpClient({
      baseUrl: 'https://x.test',
      provider: 'p',
      retries: 0,
      fetch: async () =>
        new Response(JSON.stringify({ code: '131047' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }),
    });
    const failure = await http.request({ path: '/a' }).catch((e: unknown) => e);
    expect(isWaConnectorError(failure) && failure.body).toEqual({ code: '131047' });
  });
});
