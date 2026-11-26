import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createConnector } from '../../src';
import { verifyWuzapiSignature, WUZAPI_SIGNATURE_HEADER, wuzapi } from '../../src/adapters/wuzapi';
import messageFixture from '../../src/adapters/wuzapi/fixtures/webhook-message-received.json';
import { MockAdapter } from '../../src/testing';

const HMAC_KEY = 'chave-hmac-ficticia-de-teste-com-32-chars!';

function sign(body: string, key = HMAC_KEY): string {
  return createHmac('sha256', key).update(body).digest('hex');
}

function connector(webhookHmacKey?: string) {
  return createConnector(
    wuzapi({
      baseUrl: 'https://wuzapi.exemplo.test',
      token: 'token-de-teste-nao-real',
      webhookHmacKey,
    }),
  );
}

describe('wuzapi: verificação HMAC do webhook (x-hmac-signature, HMAC-SHA256 hex)', () => {
  const rawJson = JSON.stringify(messageFixture);

  it('verifyWuzapiSignature aceita assinatura correta e rejeita o resto', () => {
    const signature = sign(rawJson);
    expect(verifyWuzapiSignature(rawJson, signature, HMAC_KEY)).toBe(true);
    expect(verifyWuzapiSignature(rawJson, signature.toUpperCase(), HMAC_KEY)).toBe(true);
    expect(verifyWuzapiSignature(new TextEncoder().encode(rawJson), signature, HMAC_KEY)).toBe(
      true,
    );
    expect(verifyWuzapiSignature(`${rawJson} `, signature, HMAC_KEY)).toBe(false);
    expect(verifyWuzapiSignature(rawJson, signature, 'outra-chave')).toBe(false);
    expect(verifyWuzapiSignature(rawJson, 'abc', HMAC_KEY)).toBe(false);
    expect(verifyWuzapiSignature(rawJson, undefined, HMAC_KEY)).toBe(false);
    expect(verifyWuzapiSignature(rawJson, signature, '')).toBe(false);
  });

  it('webhooks.verify valida corpo JSON assinado (header em qualquer caixa)', () => {
    const wa = connector(HMAC_KEY);
    const input = {
      body: messageFixture,
      rawBody: rawJson,
      headers: { 'X-HMAC-Signature': sign(rawJson) },
    };
    expect(wa.webhooks.verify(input)).toEqual({ valid: true });
    expect(WUZAPI_SIGNATURE_HEADER).toBe('x-hmac-signature');
  });

  it('valida corpo form (WEBHOOK_FORMAT=form): assinatura é sobre o urlencoded recebido', () => {
    const wa = connector(HMAC_KEY);
    const rawForm = new URLSearchParams({
      instanceName: 'minha-sessao',
      jsonData: rawJson,
      userID: '1',
    }).toString();
    const input = {
      body: { jsonData: rawJson, userID: '1', instanceName: 'minha-sessao' },
      rawBody: rawForm,
      headers: { 'x-hmac-signature': [sign(rawForm)] },
    };
    expect(wa.webhooks.verify(input).valid).toBe(true);
    const events = wa.webhooks.parse(input);
    expect(events[0]?.type).toBe('message.received');
  });

  it('parse com chave configurada: assinatura válida processa o evento', () => {
    const events = connector(HMAC_KEY).webhooks.parse({
      body: messageFixture,
      rawBody: rawJson,
      headers: { 'x-hmac-signature': sign(rawJson) },
    });
    expect(events[0]?.type).toBe('message.received');
  });

  it('parse falha fechado: assinatura errada, ausente ou sem rawBody viram unknown', () => {
    const wa = connector(HMAC_KEY);
    const wrong = wa.webhooks.parse({
      body: messageFixture,
      rawBody: rawJson,
      headers: { 'x-hmac-signature': sign(rawJson, 'chave-errada') },
    });
    const missingHeader = wa.webhooks.parse({ body: messageFixture, rawBody: rawJson });
    const missingRaw = wa.webhooks.parse({
      body: messageFixture,
      headers: { 'x-hmac-signature': sign(rawJson) },
    });
    for (const events of [wrong, missingHeader, missingRaw]) {
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe('unknown');
      expect(events[0]?.raw).toEqual(messageFixture);
    }
    expect(JSON.stringify(wrong)).not.toContain(HMAC_KEY);
  });

  it('sem webhookHmacKey o parse segue sem verificar, e verify devolve inválido (nunca válido por omissão)', () => {
    const wa = connector();
    expect(wa.webhooks.parse({ body: messageFixture })[0]?.type).toBe('message.received');
    const result = wa.webhooks.verify({ body: messageFixture, rawBody: rawJson });
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('webhookHmacKey');
  });

  it('adapter sem verifyWebhook (Mock): verify falha fechado com motivo', () => {
    const result = createConnector(new MockAdapter()).webhooks.verify({ body: {} });
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('não suporta');
  });
});
