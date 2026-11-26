import { describe, expect, it } from 'vitest';
import { createConnector } from '../../src';
import { wuzapi } from '../../src/adapters/wuzapi';
import imageS3Fixture from '../../src/adapters/wuzapi/fixtures/webhook-message-image-s3.json';
import replyFixture from '../../src/adapters/wuzapi/fixtures/webhook-message-reply.json';
import replyMediaFixture from '../../src/adapters/wuzapi/fixtures/webhook-message-reply-media-mentions.json';

const wa = createConnector(
  wuzapi({ baseUrl: 'https://wuzapi.exemplo.test', token: 'token-de-teste-nao-real' }),
);

function firstMessage(body: unknown) {
  const event = wa.webhooks.parse({ body })[0];
  if (event?.type !== 'message.received') {
    throw new Error(`evento inesperado: ${JSON.stringify(event)}`);
  }
  return event.message;
}

describe('wuzapi: mensagem citada e menções', () => {
  it('traz quotedId (stanzaID) e texto/tipo da mensagem citada', () => {
    const message = firstMessage(replyFixture);
    expect(message.text).toBe('Sim, pode ser amanha');
    expect(message.quotedId).toBe('3EB0FAKE00000000ORIG1');
    expect(message.quoted).toMatchObject({
      id: '3EB0FAKE00000000ORIG1',
      text: 'Podemos marcar para amanha?',
      kind: 'text',
      from: '5511999990000@s.whatsapp.net',
    });
    expect(message.mentionedIds).toBeUndefined();
  });

  it('resposta a mídia: legenda e tipo da citada; menções vêm de contextInfo.mentionedJID', () => {
    const message = firstMessage(replyMediaFixture);
    expect(message.kind).toBe('image');
    expect(message.quotedId).toBe('3EB0FAKE00000000ORIG2');
    expect(message.quoted?.kind).toBe('image');
    expect(message.quoted?.text).toBe('Legenda da imagem original');
    expect(message.quoted?.media?.mimeType).toBe('image/jpeg');
    expect(message.mentionedIds).toEqual([
      '5511900000000@s.whatsapp.net',
      '5511922222222@s.whatsapp.net',
    ]);
    expect(message.raw).toEqual(replyMediaFixture);
  });

  it('mensagem sem contextInfo não traz quoted nem mentionedIds', () => {
    const message = firstMessage(imageS3Fixture);
    expect(message.quotedId).toBeUndefined();
    expect(message.quoted).toBeUndefined();
    expect(message.mentionedIds).toBeUndefined();
  });

  it('citação com quotedMessage ausente ainda preserva o id', () => {
    const body = structuredClone(replyFixture) as {
      event: { Message: { extendedTextMessage: { contextInfo: Record<string, unknown> } } };
    };
    body.event.Message.extendedTextMessage.contextInfo.quotedMessage = undefined;
    const message = firstMessage(body);
    expect(message.quotedId).toBe('3EB0FAKE00000000ORIG1');
    expect(message.quoted?.text).toBeUndefined();
    expect(message.quoted?.kind).toBeUndefined();
  });

  it('aceita stanzaId com caixa alternativa', () => {
    const body = JSON.parse(JSON.stringify(replyFixture).replace('stanzaID', 'stanzaId'));
    expect(firstMessage(body).quotedId).toBe('3EB0FAKE00000000ORIG1');
  });
});
