import { describe, expect, it } from 'vitest';
import { createConnector } from '../../src';
import { wuzapi } from '../../src/adapters/wuzapi';
import fromMeFixture from '../../src/adapters/wuzapi/fixtures/webhook-message-from-me.json';
import groupFixture from '../../src/adapters/wuzapi/fixtures/webhook-message-group.json';
import lidFixture from '../../src/adapters/wuzapi/fixtures/webhook-message-lid.json';
import senderPnFixture from '../../src/adapters/wuzapi/fixtures/webhook-message-sender-pn.json';

const wa = createConnector(
  wuzapi({ baseUrl: 'https://wuzapi.exemplo.test', token: 'token-de-teste-nao-real' }),
);

function firstMessage(body: unknown) {
  const events = wa.webhooks.parse({ body });
  const event = events[0];
  if (!event || (event.type !== 'message.received' && event.type !== 'message.sent')) {
    throw new Error(`evento inesperado: ${JSON.stringify(event)}`);
  }
  return { event, message: event.message };
}

describe('wuzapi: resolução do remetente (@lid -> telefone)', () => {
  it('usa Info.SenderAlt quando Sender é @lid e expõe o lid', () => {
    const { message } = firstMessage(lidFixture);
    expect(message.from).toBe('5511900000000@s.whatsapp.net');
    expect(message.fromLid).toBe('270000000000001@lid');
  });

  it('prefere sender_pn (da nossa wuzapi), removendo o sufixo de aparelho', () => {
    const { message } = firstMessage(senderPnFixture);
    expect(message.from).toBe('5511900000000@s.whatsapp.net');
    expect(message.fromLid).toBe('270000000000001@lid');
  });

  it('sender_pn vence SenderAlt', () => {
    const body = structuredClone(lidFixture) as Record<string, unknown>;
    body.sender_pn = '5511922222222@s.whatsapp.net';
    const { message } = firstMessage(body);
    expect(message.from).toBe('5511922222222@s.whatsapp.net');
  });

  it('em grupo resolve o telefone do participante, não o JID do grupo', () => {
    const { message } = firstMessage(groupFixture);
    expect(message.chatId).toBe('120363000000000000@g.us');
    expect(message.from).toBe('5511911111111@s.whatsapp.net');
    expect(message.fromLid).toBe('270000000000002@lid');
    expect(message.isGroup).toBe(true);
  });

  it('Sender já em telefone permanece; fromMe vira message.sent', () => {
    const { event, message } = firstMessage(fromMeFixture);
    expect(event.type).toBe('message.sent');
    expect(message.fromMe).toBe(true);
    expect(message.from).toBe('5511999990000@s.whatsapp.net');
    expect(message.fromLid).toBeUndefined();
  });

  it('só LID (sem telefone resolvido): from cai no Sender original, em 1:1 o Chat não é usado', () => {
    const body = structuredClone(lidFixture) as { event: { Info: Record<string, unknown> } };
    body.event.Info.SenderAlt = undefined;
    const { message } = firstMessage(body);
    expect(message.from).toBe('270000000000001@lid');
    expect(message.fromLid).toBe('270000000000001@lid');
  });

  it('Info.Chat telefone serve de último recurso quando Sender não é telefone nem lid', () => {
    const body = structuredClone(lidFixture) as { event: { Info: Record<string, unknown> } };
    body.event.Info.SenderAlt = undefined;
    body.event.Info.Sender = 'indefinido';
    body.event.Info.Chat = '5511933333333@s.whatsapp.net';
    const { message } = firstMessage(body);
    expect(message.from).toBe('5511933333333@s.whatsapp.net');
  });

  it('preserva o payload original em raw', () => {
    const { message, event } = firstMessage(lidFixture);
    expect(message.raw).toEqual(lidFixture);
    expect(event.raw).toEqual(lidFixture);
  });
});
