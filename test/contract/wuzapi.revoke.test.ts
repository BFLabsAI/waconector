import { describe, expect, it } from 'vitest';
import { createConnector } from '../../src';
import { wuzapi } from '../../src/adapters/wuzapi';
import revokeFixture from '../../src/adapters/wuzapi/fixtures/webhook-message-revoke.json';

const wa = createConnector(
  wuzapi({ baseUrl: 'https://wuzapi.exemplo.test', token: 'token-de-teste-nao-real' }),
);

interface Loose {
  event: { Info: Record<string, unknown>; Message: { protocolMessage: Record<string, unknown> } };
}

function parseOne(body: unknown) {
  const events = wa.webhooks.parse({ body });
  expect(events).toHaveLength(1);
  return events[0];
}

describe('wuzapi: mensagem apagada (ProtocolMessage REVOKE)', () => {
  it('vira message.deleted com o id da mensagem alvo', () => {
    const event = parseOne(revokeFixture);
    expect(event).toMatchObject({
      type: 'message.deleted',
      provider: 'wuzapi',
      instanceId: 'instancia-fixture',
      messageId: 'FIXT-ALVO-0002',
      chatId: '5511900000041@s.whatsapp.net',
      fromMe: false,
    });
    expect(event?.type === 'message.deleted' && event.deletedAt).toBe(
      Date.parse('2026-11-05T12:00:00-03:00'),
    );
    expect(event?.raw).toEqual(revokeFixture);
  });

  it('aceita type ausente (protojson omite o valor zero) e "REVOKE"; fromMe vem de Info.IsFromMe', () => {
    for (const type of [undefined, 'REVOKE']) {
      const body = structuredClone(revokeFixture) as Loose;
      body.event.Message.protocolMessage.type = type;
      body.event.Info.IsFromMe = true;
      expect(parseOne(body)).toMatchObject({
        type: 'message.deleted',
        messageId: 'FIXT-ALVO-0002',
        fromMe: true,
      });
    }
  });

  it('outros tipos de protocolMessage ou sem key.ID não são exclusão', () => {
    const other = structuredClone(revokeFixture) as Loose;
    other.event.Message.protocolMessage.type = 'EPHEMERAL_SETTING';
    expect(parseOne(other)?.type).not.toBe('message.deleted');
    const noKey = structuredClone(revokeFixture) as Loose;
    noKey.event.Message.protocolMessage.key = undefined;
    expect(parseOne(noKey)?.type).not.toBe('message.deleted');
  });
});
