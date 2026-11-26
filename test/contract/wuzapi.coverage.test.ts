import { describe, expect, it } from 'vitest';
import { createConnector, isWaConnectorError } from '../../src';
import { wuzapi } from '../../src/adapters/wuzapi';
import connectedFixture from '../../src/adapters/wuzapi/fixtures/webhook-connection-update.json';
import loggedOutFixture from '../../src/adapters/wuzapi/fixtures/webhook-logged-out.json';
import imageS3Fixture from '../../src/adapters/wuzapi/fixtures/webhook-message-image-s3.json';
import reactionFixture from '../../src/adapters/wuzapi/fixtures/webhook-message-reaction.json';
import pairSuccessFixture from '../../src/adapters/wuzapi/fixtures/webhook-pair-success.json';
import qrFixture from '../../src/adapters/wuzapi/fixtures/webhook-qr.json';

interface Captured {
  method: string;
  path: string;
  body: unknown;
}

function setup(responseData: unknown = { Details: 'Updated' }) {
  const calls: Captured[] = [];
  const fetchStub: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push({
      method: (init?.method ?? 'GET').toUpperCase(),
      path: url.pathname,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    return new Response(JSON.stringify({ code: 200, success: true, data: responseData }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const adapter = wuzapi({
    baseUrl: 'https://wuzapi.exemplo.test',
    token: 'token-de-teste-nao-real',
    fetch: fetchStub,
  });
  return { adapter, wa: createConnector(adapter), calls };
}

const CHAT = '5511900000000';
const CHAT_JID = '5511900000000@s.whatsapp.net';

describe('wuzapi: capabilities do fork BF (chats, labels, channels, download, menções)', () => {
  it('declara 55 capabilities e deixa de fora o que a API não suporta', () => {
    const { adapter } = setup();
    expect(adapter.capabilities).toHaveLength(55);
    for (const capability of [
      'instance.pairingCode',
      'messages.forward',
      'messages.star',
      'messages.unstar',
      'messages.pin',
      'messages.unpin',
      'labels.list',
      'labels.create',
      'channels.create',
      'channels.getInfo',
      'channels.delete',
      'channels.getMessages',
      'channels.markViewed',
      'channels.reactToPost',
      'business.getProfile',
      'business.updateProfile',
      'calls.make',
    ] as const) {
      expect(adapter.capabilities, capability).not.toContain(capability);
    }
  });

  it('chats.mute/unmute -> POST /chat/mute {Chat, Mute}', async () => {
    const { wa, calls } = setup();
    await wa.chats.mute(CHAT);
    await wa.chats.unmute('120363000000000000@g.us');
    expect(calls).toEqual([
      { method: 'POST', path: '/chat/mute', body: { Chat: CHAT_JID, Mute: true } },
      {
        method: 'POST',
        path: '/chat/mute',
        body: { Chat: '120363000000000000@g.us', Mute: false },
      },
    ]);
  });

  it('chats.pin/unpin -> POST /chat/pinchat {Chat, Pin}', async () => {
    const { wa, calls } = setup();
    await wa.chats.pin(CHAT);
    await wa.chats.unpin(CHAT);
    expect(calls.map((c) => [c.path, c.body])).toEqual([
      ['/chat/pinchat', { Chat: CHAT_JID, Pin: true }],
      ['/chat/pinchat', { Chat: CHAT_JID, Pin: false }],
    ]);
  });

  it('chats.markRead/markUnread -> POST /chat/unread {Chat, Unread} (Unread=false lê a conversa)', async () => {
    const { wa, calls } = setup();
    await wa.chats.markRead(CHAT);
    await wa.chats.markUnread(CHAT);
    expect(calls.map((c) => [c.path, c.body])).toEqual([
      ['/chat/unread', { Chat: CHAT_JID, Unread: false }],
      ['/chat/unread', { Chat: CHAT_JID, Unread: true }],
    ]);
  });

  it('labels.update/delete/addToChat/removeFromChat', async () => {
    const { wa, calls } = setup();
    await wa.labels.update({ labelId: '7', name: 'Cliente VIP', color: '3' });
    await wa.labels.delete('7');
    await wa.labels.addToChat({ chatId: CHAT, labelId: '7' });
    await wa.labels.removeFromChat({ chatId: CHAT, labelId: '7' });
    expect(calls.map((c) => [c.path, c.body])).toEqual([
      ['/labels/edit', { LabelID: '7', Name: 'Cliente VIP', Color: 3, Deleted: false }],
      ['/labels/edit', { LabelID: '7', Deleted: true }],
      ['/labels/chat', { Chat: CHAT_JID, LabelID: '7', Labeled: true }],
      ['/labels/chat', { Chat: CHAT_JID, LabelID: '7', Labeled: false }],
    ]);
  });

  it('labels.update rejeita cor ausente/fora da paleta e id não numérico, sem chamar a rede', async () => {
    const { wa, calls } = setup();
    for (const call of [
      () => wa.labels.update({ labelId: '7', name: 'x' }),
      () => wa.labels.update({ labelId: '7', name: 'x', color: '20' }),
      () => wa.labels.update({ labelId: 'abc', name: 'x', color: '1' }),
      () => wa.labels.delete('7; drop'),
    ]) {
      const failure = await call().catch((error: unknown) => error);
      expect(isWaConnectorError(failure) && failure.code === 'INVALID_INPUT').toBe(true);
    }
    expect(calls).toHaveLength(0);
  });

  it('channels.follow/unfollow -> /newsletter/join e /newsletter/leave', async () => {
    const { wa, calls } = setup();
    await wa.channels.follow('111111111111111111@newsletter');
    await wa.channels.unfollow('111111111111111111@newsletter');
    expect(calls.map((c) => [c.path, c.body])).toEqual([
      ['/newsletter/join', { NewsletterJID: '111111111111111111@newsletter' }],
      ['/newsletter/leave', { NewsletterJID: '111111111111111111@newsletter' }],
    ]);
  });

  it('sendText com mentions e quotedId manda ContextInfo único', async () => {
    const { wa, calls } = setup({ Details: 'Sent', Timestamp: 1751000000, Id: 'ID1' });
    await wa.messages.sendText({
      to: '120363000000000000@g.us',
      text: 'oi @5511900000000',
      mentions: ['5511900000000', '5511911111111@s.whatsapp.net'],
      quotedId: 'ORIG',
      quotedParticipant: '5511911111111@s.whatsapp.net',
    });
    expect(calls[0]?.body).toEqual({
      Phone: '120363000000000000@g.us',
      Body: 'oi @5511900000000',
      ContextInfo: {
        StanzaID: 'ORIG',
        Participant: '5511911111111@s.whatsapp.net',
        MentionedJID: ['5511900000000@s.whatsapp.net', '5511911111111@s.whatsapp.net'],
      },
    });
  });

  it('messages.download usa o descritor do webhook (json) e devolve base64/mimeType', async () => {
    const { wa, calls } = setup({
      Mimetype: 'image/jpeg',
      Data: 'data:image/jpeg;base64,ZmFrZS1pbWFnZQ==',
    });
    const downloaded = await wa.messages.download({ messageId: 'x', raw: imageS3Fixture });
    expect(downloaded.base64).toBe('ZmFrZS1pbWFnZQ==');
    expect(downloaded.mimeType).toBe('image/jpeg');
    expect(calls[0]?.path).toBe('/chat/downloadimage');
    expect(calls[0]?.body).toEqual({
      Url: 'https://mmg.exemplo.test/cifrado/abc.enc',
      DirectPath: '/v/t62.7118-24/exemplo',
      MediaKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      Mimetype: 'image/jpeg',
      FileEncSHA256: 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC=',
      FileSHA256: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=',
      FileLength: 48219,
    });
  });

  it('messages.download escolhe a rota pelo tipo e aceita raw em modo form (jsonData)', async () => {
    const { wa, calls } = setup({ Mimetype: 'audio/ogg', Data: 'data:audio/ogg;base64,QQ==' });
    const raw = {
      jsonData: JSON.stringify({
        type: 'Message',
        event: { Message: { audioMessage: { mimetype: 'audio/ogg', fileLength: 10 } } },
      }),
    };
    await wa.messages.download({ messageId: 'x', raw });
    expect(calls[0]?.path).toBe('/chat/downloadaudio');
  });

  it('messages.download com raw sem mídia lança INVALID_INPUT sem chamar a rede', async () => {
    const { wa, calls } = setup();
    const failure = await wa.messages
      .download({ messageId: 'x', raw: { type: 'Message', event: { Message: {} } } })
      .catch((error: unknown) => error);
    expect(isWaConnectorError(failure) && failure.code === 'INVALID_INPUT').toBe(true);
    expect(calls).toHaveLength(0);
  });
});

describe('wuzapi: eventos de conexão, reação e recibos', () => {
  const { wa } = setup();
  const parse = (body: unknown) => wa.webhooks.parse({ body });

  it('Connected/PairSuccess -> connected; LoggedOut/Disconnected/PairError -> disconnected', () => {
    expect(parse(connectedFixture)[0]).toMatchObject({
      type: 'connection.update',
      state: 'connected',
    });
    expect(parse(pairSuccessFixture)[0]).toMatchObject({
      type: 'connection.update',
      state: 'connected',
    });
    expect(parse(loggedOutFixture)[0]).toMatchObject({
      type: 'connection.update',
      state: 'disconnected',
      instanceId: 'minha-sessao',
    });
    for (const type of [
      'Disconnected',
      'PairError',
      'ClientOutdated',
      'TemporaryBan',
      'QRTimeout',
    ]) {
      expect(parse({ type, event: 'x' })[0]).toMatchObject({
        type: 'connection.update',
        state: 'disconnected',
      });
    }
    expect(parse({ type: 'KeepAliveTimeout' })[0]).toMatchObject({ state: 'connecting' });
    expect(parse({ type: 'KeepAliveRestored' })[0]).toMatchObject({ state: 'connected' });
  });

  it('QR -> connection.update state=qr com o código', () => {
    expect(parse(qrFixture)[0]).toMatchObject({
      type: 'connection.update',
      state: 'qr',
      qr: 'data:image/png;base64,QQ==',
    });
  });

  it('reação recebida traz emoji e mensagem-alvo', () => {
    const event = parse(reactionFixture)[0];
    expect(event?.type).toBe('message.received');
    if (event?.type === 'message.received') {
      expect(event.message.kind).toBe('reaction');
      expect(event.message.reaction).toEqual({
        emoji: '👍',
        targetMessageId: '3EB0FAKE00000000ORIG3',
      });
    }
  });

  it('recibos Delivered/Read/ReadSelf viram message.ack, um por id', () => {
    const base = {
      type: 'ReadReceipt',
      event: { MessageIDs: ['A1', 'A2'], Chat: CHAT_JID },
    };
    expect(parse({ ...base, state: 'Delivered' }).map((e) => e.type)).toEqual([
      'message.ack',
      'message.ack',
    ]);
    expect(parse({ ...base, state: 'Delivered' })[0]).toMatchObject({
      messageId: 'A1',
      ack: 'delivered',
    });
    expect(parse({ ...base, state: 'Read' })[1]).toMatchObject({ messageId: 'A2', ack: 'read' });
    expect(parse({ ...base, state: 'ReadSelf' })[0]).toMatchObject({ ack: 'read' });
  });

  it('nunca lança: tipo desconhecido e corpo inválido viram unknown', () => {
    expect(parse({ type: 'Presence', from: 'x' })[0]?.type).toBe('unknown');
    expect(parse('texto')[0]?.type).toBe('unknown');
    expect(parse(null)[0]?.type).toBe('unknown');
  });
});
