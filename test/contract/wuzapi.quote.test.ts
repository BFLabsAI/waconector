import { describe, expect, it } from 'vitest';
import { createConnector } from '../../src';
import { wuzapi } from '../../src/adapters/wuzapi';

interface Captured {
  path: string;
  body: Record<string, unknown>;
}

function build() {
  const calls: Captured[] = [];
  const wa = createConnector(
    wuzapi({
      baseUrl: 'https://wuzapi.exemplo.test',
      token: 'token-de-teste-nao-real',
      fetch: async (input, init) => {
        calls.push({
          path: new URL(String(input)).pathname,
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        });
        return new Response(
          JSON.stringify({
            code: 200,
            success: true,
            data: { Id: 'FIXT-ENVIADA-1', Timestamp: 1 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    }),
  );
  return { wa, calls };
}

const GROUP = '120363000000000001@g.us';

describe('wuzapi: autor da mensagem citada (ContextInfo.Participant)', () => {
  it('usa quotedParticipant (LID) no texto, junto de menções', async () => {
    const { wa, calls } = build();
    await wa.messages.sendText({
      to: GROUP,
      text: '@100000000000012, sua vez.',
      quotedId: 'FIXT-GRUPO-0003',
      quotedParticipant: '100000000000012@lid',
      mentions: ['100000000000012@lid'],
    });
    expect(calls[0]?.body).toEqual({
      Phone: GROUP,
      Body: '@100000000000012, sua vez.',
      ContextInfo: {
        StanzaID: 'FIXT-GRUPO-0003',
        Participant: '100000000000012@lid',
        MentionedJID: ['100000000000012@lid'],
      },
    });
  });

  it('1:1 sem quotedParticipant: o próprio chat é o autor', async () => {
    const { wa, calls } = build();
    await wa.messages.sendText({
      to: '100000000000030@lid',
      text: 'Anotado.',
      quotedId: 'FIXT-CITADA-0001',
    });
    expect(calls[0]?.body.ContextInfo).toEqual({
      StanzaID: 'FIXT-CITADA-0001',
      Participant: '100000000000030@lid',
    });
  });

  it('grupo sem quotedParticipant: não inventa autor, envia sem citação', async () => {
    const { wa, calls } = build();
    await wa.messages.sendText({ to: GROUP, text: 'oi', quotedId: 'FIXT-GRUPO-0003' });
    expect(calls[0]?.body).toEqual({ Phone: GROUP, Body: 'oi' });
  });

  it('mídia: mesma regra (autor explícito, 1:1, grupo sem autor)', async () => {
    const { wa, calls } = build();
    const media = { kind: 'image' as const, url: 'https://cdn.exemplo.test/foto.jpg' };
    await wa.messages.sendMedia({
      to: GROUP,
      media,
      quotedId: 'FIXT-GRUPO-0003',
      quotedParticipant: '100000000000012@lid',
    });
    await wa.messages.sendMedia({ to: GROUP, media, quotedId: 'FIXT-GRUPO-0003' });
    await wa.messages.sendMedia({ to: '5511900000001', media, quotedId: 'FIXT-TEXTO-0001' });
    expect(calls[0]?.body.ContextInfo).toEqual({
      StanzaID: 'FIXT-GRUPO-0003',
      Participant: '100000000000012@lid',
    });
    expect(calls[1]?.body.ContextInfo).toBeUndefined();
    expect(calls[2]?.body.ContextInfo).toEqual({
      StanzaID: 'FIXT-TEXTO-0001',
      Participant: '5511900000001',
    });
  });
});
