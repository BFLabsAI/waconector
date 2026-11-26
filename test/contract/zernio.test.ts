import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createConnector, isKnownCapability, isWaConnectorError } from '../../src';
import {
  classifySentOrigin,
  verifyZernioSignature,
  zernio,
  zernioEventId,
  zernioMediaIdFromUrl,
} from '../../src/adapters/zernio';
import {
  type Call,
  CHAT_ID,
  CONVERSATION_ID,
  fixture,
  fixtureRaw,
  happyRoutes,
  json,
  mockFetch,
  route,
} from './zernio-helpers';

const KEY = 'chave-de-teste-nao-real';
const SECRET = 'fixture-secret';
const ACC = 'acc00000000000000000001';

function make(
  extra: Partial<Parameters<typeof zernio>[0]> = {},
  handlers = happyRoutes(),
  calls: Call[] = [],
) {
  const adapter = zernio({
    apiKey: KEY,
    accountId: ACC,
    history: { maxAgeMs: 0 },
    retries: 0,
    fetch: mockFetch(handlers, calls),
    ...extra,
  });
  return { adapter, wa: createConnector(adapter), calls };
}

const sign = (raw: string, secret = SECRET) =>
  createHmac('sha256', secret).update(raw).digest('hex');

describe('zernio: capabilities', () => {
  it('declara só capabilities conhecidas e não declara o que o Zernio não faz', () => {
    const { adapter } = make();
    for (const c of adapter.capabilities) expect(isKnownCapability(c)).toBe(true);
    for (const missing of [
      'messages.edit',
      'messages.delete',
      'messages.sendPoll',
      'messages.markRead',
      'groups.create',
      'instance.connect',
      'calls.make',
    ]) {
      expect(adapter.capabilities).not.toContain(missing);
    }
    expect(adapter.capabilities).toContain('messages.sendTemplate');
  });
});

describe('zernio: webhooks → eventos canônicos', () => {
  const parse = (name: string, extra = {}) => {
    const { wa } = make(extra);
    return wa.webhooks.parse({ body: fixture(name) });
  };

  it('texto recebido', () => {
    const [event] = parse('webhook-message-received-text.json');
    expect(event?.type).toBe('message.received');
    if (event?.type !== 'message.received') return;
    expect(event.instanceId).toBe(ACC);
    expect(event.message).toMatchObject({
      id: 'wamid.FIXTURE0001',
      chatId: CHAT_ID,
      from: CHAT_ID,
      fromMe: false,
      kind: 'text',
      text: 'Olá, quero saber o preço',
    });
  });

  it('nota de voz e imagem expõem só o mediaId (URL é autenticada)', () => {
    const [voice] = parse('webhook-message-received-voice-note.json');
    const [image] = parse('webhook-message-received-image-caption.json');
    if (voice?.type !== 'message.received' || image?.type !== 'message.received') {
      throw new Error('esperava message.received');
    }
    expect(voice.message.kind).toBe('audio');
    expect(voice.message.media).toEqual({ kind: 'audio', id: 'MEDIA0001', mimeType: 'audio/ogg' });
    expect(image.message.kind).toBe('image');
    expect(image.message.media?.id).toBe('MEDIA0002');
    expect(image.message.media?.url).toBeUndefined();
    expect(image.message.text).toBe('segue a foto');
  });

  it('resposta de botão traz quotedId', () => {
    const [event] = parse('webhook-message-received-button-reply.json');
    if (event?.type !== 'message.received') throw new Error('x');
    expect(event.message.quotedId).toBe('wamid.FIXTURE0002');
  });

  it('contato sem telefone (BSUID) usa o BSUID como chatId e from', () => {
    const [event] = parse('webhook-message-received-bsuid-no-phone.json');
    if (event?.type !== 'message.received') throw new Error('x');
    expect(event.message.chatId).toBe('BR.FIXTUREBSUID0001');
    expect(event.message.from).toBe('BR.FIXTUREBSUID0001');
  });

  it('standby segue como message.received com a marca preservada em raw', () => {
    const [event] = parse('webhook-message-received-standby.json');
    if (event?.type !== 'message.received') throw new Error('x');
    expect((event.raw as { metadata: { standby: boolean } }).metadata.standby).toBe(true);
  });

  it('eco do celular: message.sent, fromMe, origin external_device, chatId = participante', () => {
    const [event] = parse('webhook-message-sent-coexistence-echo.json');
    if (event?.type !== 'message.sent') throw new Error('x');
    expect(event.origin).toBe('external_device');
    expect(event.message.fromMe).toBe(true);
    expect(event.message.chatId).toBe(CHAT_ID);
    expect(event.message.from).toBeUndefined();
  });

  it('envio pela API: origin self', () => {
    const [event] = parse('webhook-message-sent-api.json');
    if (event?.type !== 'message.sent') throw new Error('x');
    expect(event.origin).toBe('self');
  });

  it('classifySentOrigin cobre as fontes conhecidas', () => {
    expect(classifySentOrigin({ source: 'whatsapp_business_app' })).toBe('external_device');
    expect(classifySentOrigin({ source: 'cloud_api' })).toBe('self');
    expect(classifySentOrigin({ source: 'meta_business_agent' })).toBe('unknown');
    expect(classifySentOrigin({ sentVia: 'broadcast' })).toBe('self');
    expect(classifySentOrigin({})).toBe('unknown');
  });

  it('acks: delivered, read e failed(error) com chatId', () => {
    const acks = ['delivered', 'read'].map((n) => parse(`webhook-message-${n}.json`)[0]);
    const failed = parse('webhook-message-failed-window-closed.json')[0];
    expect(acks.map((e) => e?.type === 'message.ack' && e.ack)).toEqual(['delivered', 'read']);
    if (failed?.type !== 'message.ack') throw new Error('x');
    expect(failed.ack).toBe('error');
    expect(failed.messageId).toBe('wamid.FIXTURE0002');
    expect(failed.chatId).toBe(CHAT_ID);
    expect((failed.raw as { error: { code: string } }).error.code).toBe('131047');
  });

  it('reação adicionada e removida (emoji vazio) vira message.received kind reaction', () => {
    const [added] = parse('webhook-reaction-added.json');
    const [removed] = parse('webhook-reaction-removed.json');
    if (added?.type !== 'message.received' || removed?.type !== 'message.received') {
      throw new Error('x');
    }
    expect(added.message.reaction).toEqual({ emoji: '👍', targetMessageId: 'wamid.FIXTURE0002' });
    expect(removed.message.reaction?.emoji).toBe('');
  });

  it('eventos sem equivalente canônico viram unknown com reason e raw', () => {
    for (const [name, reason] of [
      ['webhook-message-edited.json', 'message.edited'],
      ['webhook-message-deleted.json', 'message.deleted'],
      ['webhook-conversation-started.json', 'conversation.started'],
      ['webhook-conversation-control-changed.json', 'conversation.control_changed'],
      ['webhook-webhook-test.json', 'webhook.test'],
      ['webhook-unknown-event.json', 'some.future.event'],
    ] as const) {
      const [event] = parse(name);
      expect(event?.type).toBe('unknown');
      if (event?.type === 'unknown') expect(event.reason).toBe(reason);
    }
  });

  it('payload malformado nunca lança', () => {
    const { wa } = make();
    for (const body of [null, 'x', 42, [], {}, { event: 'message.received' }]) {
      expect(wa.webhooks.parse({ body })[0]?.type).toBe('unknown');
    }
  });

  it('conexão: disconnected e connected', () => {
    const base = { id: 'e1', timestamp: 't', account: { id: ACC, accountId: ACC } };
    const { wa } = make();
    const off = wa.webhooks.parse({ body: { ...base, event: 'account.disconnected' } })[0];
    const on = wa.webhooks.parse({ body: { ...base, id: 'e2', event: 'account.connected' } })[0];
    expect(off?.type === 'connection.update' && off.state).toBe('disconnected');
    expect(on?.type === 'connection.update' && on.state).toBe('connected');
  });
});

describe('zernio: HMAC do webhook', () => {
  const raw = fixtureRaw('webhook-message-received-text.json');
  const body = JSON.parse(raw);

  it('verifyZernioSignature aceita só a assinatura correta', () => {
    expect(verifyZernioSignature(raw, sign(raw), SECRET)).toBe(true);
    expect(verifyZernioSignature(raw, sign(raw).toUpperCase(), SECRET)).toBe(true);
    expect(verifyZernioSignature(`${raw} `, sign(raw), SECRET)).toBe(false);
    expect(verifyZernioSignature(raw, sign(raw, 'outro'), SECRET)).toBe(false);
    expect(verifyZernioSignature(raw, undefined, SECRET)).toBe(false);
    expect(verifyZernioSignature(raw, 'abc', SECRET)).toBe(false);
    expect(verifyZernioSignature(raw, sign(raw), '')).toBe(false);
  });

  it('com segredo: válido processa; inválido, ausente e sem rawBody falham fechado', () => {
    const { wa } = make({ webhookSecret: SECRET });
    const ok = wa.webhooks.parse({
      body,
      rawBody: raw,
      headers: { 'X-Zernio-Signature': sign(raw) },
    });
    expect(ok[0]?.type).toBe('message.received');
    const bad = [
      { body, rawBody: raw, headers: { 'x-zernio-signature': sign(raw, 'errado') } },
      { body, rawBody: raw },
      { body, headers: { 'x-zernio-signature': sign(raw) } },
    ].map((input) => make({ webhookSecret: SECRET }).wa.webhooks.parse(input)[0]);
    for (const event of bad) expect(event?.type).toBe('unknown');
    expect(JSON.stringify(bad)).not.toContain(SECRET);
  });

  it('aceita o header legado x-late-signature', () => {
    const { wa } = make({ webhookSecret: SECRET });
    expect(
      wa.webhooks.verify({ body, rawBody: raw, headers: { 'x-late-signature': sign(raw) } }).valid,
    ).toBe(true);
  });

  it('sem segredo, verify falha fechado (nunca válido por omissão)', () => {
    const { wa } = make();
    expect(wa.webhooks.verify({ body, rawBody: raw }).valid).toBe(false);
  });
});

describe('zernio: dedupe e filtro de histórico', () => {
  it('mesmo id de evento: o segundo vira unknown duplicate_event', () => {
    const { wa } = make();
    const body = fixture('webhook-message-received-text.json');
    expect(wa.webhooks.parse({ body })[0]?.type).toBe('message.received');
    const again = wa.webhooks.parse({ body, headers: { 'x-zernio-event-id': 'evt-0001' } })[0];
    expect(again?.type === 'unknown' && again.reason).toBe('duplicate_event');
  });

  it('dedupe: false deixa o gateway deduplicar; zernioEventId expõe o id', () => {
    const { wa } = make({ dedupe: false });
    const body = fixture('webhook-message-received-text.json');
    wa.webhooks.parse({ body });
    expect(wa.webhooks.parse({ body })[0]?.type).toBe('message.received');
    expect(zernioEventId({ body })).toBe('evt-0001');
    expect(zernioEventId({ body: {}, headers: { 'X-Zernio-Event-Id': 'h1' } })).toBe('h1');
  });

  it('porta de dedupe customizada é usada', () => {
    const seen = new Set<string>();
    const { wa } = make({
      dedupe: {
        seen: (id) => {
          const already = seen.has(id);
          seen.add(id);
          return already;
        },
      },
    });
    const body = fixture('webhook-message-received-text.json');
    wa.webhooks.parse({ body });
    expect(wa.webhooks.parse({ body })[0]?.type).toBe('unknown');
  });

  it('mensagem antiga (histórico sincronizado) não vira message.received', () => {
    const { wa } = make({ history: {} }); // padrão: 2 h; as fixtures são de janeiro
    const [event] = wa.webhooks.parse({ body: fixture('webhook-message-received-text.json') });
    expect(event?.type === 'unknown' && event.reason).toBe('history_sync');
    const echo = wa.webhooks.parse({
      body: fixture('webhook-message-sent-coexistence-echo.json'),
    })[0];
    expect(echo?.type === 'unknown' && echo.reason).toBe('history_sync');
  });

  it('mensagem recente passa; metadata.source coexistence_history é filtrada mesmo recente', () => {
    const recent = fixture<{ message: { sentAt: string }; metadata: unknown }>(
      'webhook-message-received-text.json',
    );
    recent.message.sentAt = new Date().toISOString();
    expect(make({ history: {} }).wa.webhooks.parse({ body: recent })[0]?.type).toBe(
      'message.received',
    );
    const history = { ...recent, id: 'evt-h', metadata: { source: 'coexistence_history' } };
    const [event] = make({ history: {} }).wa.webhooks.parse({ body: history });
    expect(event?.type === 'unknown' && event.reason).toBe('history_sync');
  });

  it('acks e reações não passam pelo filtro de idade', () => {
    const { wa } = make({ history: {} });
    expect(wa.webhooks.parse({ body: fixture('webhook-message-read.json') })[0]?.type).toBe(
      'message.ack',
    );
  });
});

describe('zernio: envio e porta telefone → conversationId', () => {
  it('sem conversa em cache: busca no Zernio, guarda e envia com Idempotency-Key e replyTo', async () => {
    const { wa, calls } = make();
    const sent = await wa.messages.sendText({
      to: '+1 555 010 0001',
      text: 'oi',
      quotedId: 'wamid.X',
    });
    expect(sent).toMatchObject({ id: 'wamid.FIXTURE0002', chatId: CHAT_ID });
    const post = calls.find((c) => c.method === 'POST');
    expect(post?.url.pathname).toBe(`/api/v1/inbox/conversations/${CONVERSATION_ID}/messages`);
    expect(post?.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(post?.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
    expect(post?.body).toEqual({ accountId: ACC, message: 'oi', replyTo: 'wamid.X' });
    // segundo envio usa a porta (sem nova busca)
    await wa.messages.sendText({ to: CHAT_ID, text: 'de novo' });
    expect(calls.filter((c) => c.url.pathname.endsWith('/search'))).toHaveLength(1);
  });

  it('o webhook alimenta a porta: nenhuma busca antes do envio', async () => {
    const { wa, calls } = make();
    wa.webhooks.parse({ body: fixture('webhook-message-received-text.json') });
    await new Promise((r) => setTimeout(r, 0));
    await wa.messages.sendText({ to: CHAT_ID, text: 'oi' });
    expect(calls.some((c) => c.url.pathname.endsWith('/search'))).toBe(false);
  });

  it('porta injetada pelo gateway é consultada e alimentada', async () => {
    const map = new Map<string, string>([[CHAT_ID, 'cnv-do-gateway']]);
    const { wa, calls } = make({
      conversations: { get: async (id) => map.get(id), set: async (id, c) => void map.set(id, c) },
    });
    await wa.messages.sendText({ to: CHAT_ID, text: 'oi' });
    expect(calls[0]?.url.pathname).toContain('/cnv-do-gateway/messages');
  });

  it('sem conversa alguma: WINDOW_CLOSED sem enviar nada', async () => {
    const { wa, calls } = make({}, [route('GET', '/search', () => json(200, { data: [] }))]);
    const failure = await wa.messages
      .sendText({ to: CHAT_ID, text: 'oi' })
      .catch((e: unknown) => e);
    expect(isWaConnectorError(failure) && failure.code).toBe('WINDOW_CLOSED');
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('erros da Meta viram códigos tipados e preservam providerCode/body', async () => {
    const cases: Array<[unknown, string, string]> = [
      [fixture('rest-error-window-closed-400.json'), 'WINDOW_CLOSED', '131047'],
      [fixture('rest-error-template-required-400.json'), 'WINDOW_CLOSED', 'TEMPLATE_REQUIRED'],
      [
        { error: 'x', type: 'platform_error', platformError: { code: 132001 } },
        'TEMPLATE_NOT_FOUND',
        '132001',
      ],
      [{ error: 'x', code: '131026' }, 'INVALID_RECIPIENT', '131026'],
      [fixture('rest-error-per-recipient-131056-400.json'), 'RATE_LIMITED', '131056'],
    ];
    for (const [body, code, providerCode] of cases) {
      const { wa } = make({}, [
        ...happyRoutes().slice(0, 1),
        route('POST', '/messages', () => json(400, body)),
      ]);
      const failure = await wa.messages
        .sendText({ to: CHAT_ID, text: 'oi' })
        .catch((e: unknown) => e);
      expect(isWaConnectorError(failure) && [failure.code, failure.providerCode]).toEqual([
        code,
        providerCode,
      ]);
      if (isWaConnectorError(failure)) expect(failure.body).toEqual(body);
    }
  });

  it('401 vira AUTH_FAILED e a chave nunca aparece na mensagem', async () => {
    const { wa } = make({}, [route('GET', '/search', () => json(401, { error: `bad ${KEY}` }))]);
    const failure = await wa.messages
      .sendText({ to: CHAT_ID, text: 'oi' })
      .catch((e: unknown) => e);
    expect(isWaConnectorError(failure) && failure.code).toBe('AUTH_FAILED');
    expect(String((failure as Error).message)).not.toContain(KEY);
  });

  it('mídia por URL: documento vira file; ogg vira voiceNote; sticker é recusado', async () => {
    const { wa, calls } = make();
    await wa.messages.sendMedia({
      to: CHAT_ID,
      media: { kind: 'document', url: 'https://x.test/a.pdf', filename: 'a.pdf' },
      caption: 'veja',
    });
    await wa.messages.sendMedia({
      to: CHAT_ID,
      media: { kind: 'audio', url: 'https://x.test/a.ogg', mimeType: 'audio/ogg' },
    });
    const posts = calls.filter((c) => c.method === 'POST').map((c) => c.body);
    expect(posts[0]).toMatchObject({
      attachmentUrl: 'https://x.test/a.pdf',
      attachmentType: 'file',
      attachmentName: 'a.pdf',
      message: 'veja',
    });
    expect(posts[1]).toMatchObject({ attachmentType: 'audio', voiceNote: true });
    const failure = await wa.messages
      .sendMedia({ to: CHAT_ID, media: { kind: 'sticker', url: 'https://x.test/s.webp' } })
      .catch((e: unknown) => e);
    expect(isWaConnectorError(failure) && failure.code).toBe('INVALID_INPUT');
  });

  it('mídia em base64 sobe por upload-direct e envia a URL devolvida', async () => {
    const { wa, calls } = make({}, [
      route('POST', '/v1/media/upload-direct', () =>
        json(200, { url: 'https://media.test/u.jpg' }),
      ),
      ...happyRoutes(),
    ]);
    await wa.messages.sendMedia({
      to: CHAT_ID,
      media: {
        kind: 'image',
        base64: Buffer.from('img').toString('base64'),
        mimeType: 'image/jpeg',
      },
    });
    const upload = calls.find((c) => c.url.pathname.endsWith('/upload-direct'));
    expect(upload?.rawBody).toBeInstanceOf(FormData);
    expect(upload?.headers.authorization).toBe(`Bearer ${KEY}`);
    const send = calls.filter((c) => c.method === 'POST').at(-1);
    expect(send?.body).toMatchObject({
      attachmentUrl: 'https://media.test/u.jpg',
      attachmentType: 'image',
    });
  });

  it('reação: adiciona com POST e remove (emoji vazio) com DELETE', async () => {
    const { wa, calls } = make();
    await wa.messages.sendReaction({ to: CHAT_ID, messageId: 'wamid.A', emoji: '👍' });
    await wa.messages.sendReaction({ to: CHAT_ID, messageId: 'wamid.A', emoji: '' });
    const rx = calls.filter((c) => c.url.pathname.endsWith('/reactions'));
    expect(rx.map((c) => c.method)).toEqual(['POST', 'DELETE']);
    expect(rx[0]?.body).toEqual({ accountId: ACC, emoji: '👍' });
    expect(rx[1]?.url.searchParams.get('accountId')).toBe(ACC);
  });

  it('localização e cartão de contato', async () => {
    const { wa, calls } = make();
    await wa.messages.sendLocation({ to: CHAT_ID, latitude: 1, longitude: 2, name: 'Loja' });
    await wa.messages.sendContactCard({
      to: CHAT_ID,
      contactName: 'Ana',
      contactPhone: '15550100002',
    });
    const [loc, card] = calls.filter((c) => c.method === 'POST').map((c) => c.body);
    expect(loc).toMatchObject({ location: { latitude: 1, longitude: 2, name: 'Loja' } });
    expect(card).toMatchObject({ contacts: [{ name: { formatted_name: 'Ana' } }] });
  });
});

describe('zernio: sendTemplate', () => {
  it('abre conversa sem precisar do conversationId e guarda o devolvido', async () => {
    const { wa, calls } = make({}, [
      route('POST', '/v1/inbox/conversations', () =>
        json(201, fixture('rest-open-conversation-template-201.json')),
      ),
      ...happyRoutes(),
    ]);
    const sent = await wa.messages.sendTemplate({
      to: '+1 555 010 0001',
      name: 'pedido_confirmado',
      language: 'pt_BR',
      params: ['Ana', 'PED-1'],
      buttonParams: [{ index: 0, subType: 'url', value: 'abc' }],
    });
    expect(sent.id).toBe('wamid.FIXTURE0010');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url.pathname).toBe('/api/v1/inbox/conversations');
    expect(calls[0]?.body).toEqual({
      accountId: ACC,
      participantId: CHAT_ID,
      templateName: 'pedido_confirmado',
      templateLanguage: 'pt_BR',
      templateParams: ['Ana', 'PED-1'],
      templateButtonParams: [{ index: 0, subType: 'url', value: 'abc' }],
    });
    expect(calls[0]?.headers['idempotency-key']).toBeTruthy();
    await wa.messages.sendText({ to: CHAT_ID, text: 'depois' });
    expect(calls.some((c) => c.url.pathname.endsWith('/search'))).toBe(false);
  });

  it('template inexistente vira TEMPLATE_NOT_FOUND', async () => {
    const { wa } = make({}, [
      route('POST', '/v1/inbox/conversations', () =>
        json(400, {
          error: 'x',
          type: 'platform_error',
          code: 'platform_api_error',
          platformError: { details: { phase: 'template_lookup' } },
        }),
      ),
    ]);
    const failure = await wa.messages
      .sendTemplate({ to: CHAT_ID, name: 'nao_existe', language: 'pt_BR' })
      .catch((e: unknown) => e);
    expect(isWaConnectorError(failure) && failure.code).toBe('TEMPLATE_NOT_FOUND');
  });
});

describe('zernio: download, status, saúde e demais', () => {
  it('download usa o mediaId (do raw ou do messageId) e devolve base64', async () => {
    const { wa, calls } = make();
    const [event] = wa.webhooks.parse({
      body: fixture('webhook-message-received-voice-note.json'),
    });
    if (event?.type !== 'message.received') throw new Error('x');
    const out = await wa.messages.download({
      messageId: event.message.media?.id ?? '',
      raw: event.message.raw,
    });
    expect(Buffer.from(out.base64, 'base64').toString()).toBe('conteudo-fake');
    expect(out.mimeType).toBe('audio/ogg');
    expect(calls[0]?.url.pathname).toBe('/api/v1/whatsapp/media/MEDIA0001');
    expect(zernioMediaIdFromUrl('https://zernio.com/api/v1/whatsapp/media/ABC?accountId=1')).toBe(
      'ABC',
    );
    expect(zernioMediaIdFromUrl('https://x.test/outra')).toBeUndefined();
  });

  it('mídia descartada pela Meta (400) vira MEDIA_EXPIRED', async () => {
    const { wa } = make({}, [
      route('GET', '/v1/whatsapp/media/', () => json(400, { error: 'gone' })),
    ]);
    const failure = await wa.messages.download({ messageId: 'MEDIA0001' }).catch((e: unknown) => e);
    expect(isWaConnectorError(failure) && failure.code).toBe('MEDIA_EXPIRED');
  });

  it('status: CONNECTED; saúde expõe qualidade e tier', async () => {
    const { adapter, wa } = make();
    expect((await wa.instance.status()).state).toBe('connected');
    const health = await adapter.health();
    expect(health).toMatchObject({
      state: 'connected',
      qualityRating: 'GREEN',
      messagingLimitTier: 'TIER_1K',
      throughputLevel: 'STANDARD',
      platformType: 'CLOUD_API',
    });
  });

  it('status: Graph 100/33 (desconexão pelo celular) vira disconnected; 401 propaga', async () => {
    const gone = make({}, [
      route('GET', 'number-info', () =>
        json(400, { error: 'x', platformError: { code: 100, subcode: 33 } }),
      ),
    ]);
    expect((await gone.wa.instance.status()).state).toBe('disconnected');
    const denied = make({}, [route('GET', 'number-info', () => json(401, { error: 'x' }))]);
    const failure = await denied.wa.instance.status().catch((e: unknown) => e);
    expect(isWaConnectorError(failure) && failure.code).toBe('AUTH_FAILED');
  });

  it('chats e presença: arquivar, ler, digitando (paused é no-op)', async () => {
    const { wa, calls } = make();
    await wa.chats.archive(CHAT_ID);
    await wa.chats.markRead(CHAT_ID);
    await wa.presence.setTyping({ to: CHAT_ID, state: 'composing' });
    const before = calls.length;
    await wa.presence.setTyping({ to: CHAT_ID, state: 'paused' });
    expect(calls.length).toBe(before);
    const put = calls.find((c) => c.method === 'PUT');
    expect(put?.body).toEqual({ accountId: ACC, status: 'archived' });
    expect(calls.some((c) => c.url.pathname.endsWith('/read'))).toBe(true);
    expect(calls.some((c) => c.url.pathname.endsWith('/typing'))).toBe(true);
  });

  it('bloqueio e contatos do CRM', async () => {
    const { wa, calls } = make({}, [
      route('POST', 'block-users', () =>
        json(200, { blocked: [{ input: '+15550100001' }], failed: [] }),
      ),
      route('DELETE', 'block-users', () => json(200, { blocked: [], failed: [] })),
      route('GET', 'block-users', () =>
        json(200, { blockedUsers: [{ waId: '15550100009' }], nextCursor: null }),
      ),
      route('GET', '/v1/contacts', () =>
        json(200, {
          contacts: [{ id: 'c1', name: 'Cliente Exemplo', platformIdentifier: '15550100001' }],
          pagination: { hasMore: false },
        }),
      ),
    ]);
    await wa.contacts.block(CHAT_ID);
    await wa.contacts.unblock(CHAT_ID);
    expect(await wa.contacts.listBlocked()).toEqual(['15550100009']);
    expect((await wa.contacts.get(CHAT_ID)).name).toBe('Cliente Exemplo');
    expect(await wa.contacts.list()).toHaveLength(1);
    expect(calls[0]?.body).toEqual({ accountId: ACC, users: ['+15550100001'] });
  });

  it('perfil comercial: leitura e atualização', async () => {
    const { wa, calls } = make({}, [
      route('GET', 'business-profile', () =>
        json(200, {
          businessProfile: {
            about: 'a',
            description: 'Descrição',
            websites: ['https://x.test'],
            vertical: 'RETAIL',
          },
        }),
      ),
      route('POST', 'business-profile', () => json(200, { success: true })),
    ]);
    const profile = await wa.business.getProfile();
    expect(profile).toMatchObject({
      description: 'Descrição',
      websites: ['https://x.test'],
      categories: ['RETAIL'],
    });
    await wa.business.updateProfile({ email: 'a@exemplo.test' });
    expect(calls[1]?.body).toEqual({ accountId: ACC, email: 'a@exemplo.test' });
  });

  it('logout não é suportado e connect só devolve raw', async () => {
    const { adapter } = make();
    expect(await adapter.instance.connect()).toHaveProperty('raw');
    const failure = await adapter.instance.logout().catch((e: unknown) => e);
    expect(isWaConnectorError(failure) && failure.code).toBe('UNSUPPORTED_CAPABILITY');
  });
});
