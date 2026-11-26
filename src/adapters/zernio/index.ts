import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type {
  BusinessApi,
  ChatsApi,
  ContactsApi,
  InstanceApi,
  MessagesApi,
  PresenceApi,
  WaAdapter,
  WebhookInput,
  WebhookVerification,
} from '../../core/adapter';
import type { CapabilitySet } from '../../core/capabilities';
import { WaConnectorError } from '../../core/errors';
import type {
  CanonicalEvent,
  ConnectionUpdateEvent,
  MessageAckEvent,
  SentOrigin,
  UnknownEvent,
} from '../../core/events';
import { HttpClient } from '../../core/http';
import type {
  BusinessProfile,
  Contact,
  DownloadedMedia,
  DownloadMediaInput,
  InstanceState,
  InstanceStatus,
  MediaKind,
  MediaRef,
  MessageAck,
  MessageKind,
  SendContactCardInput,
  SendLocationInput,
  SendMediaInput,
  SendReactionInput,
  SendTemplateInput,
  SendTextInput,
  SentMessage,
  SetTypingInput,
  UpdateBusinessProfileInput,
  WaMessage,
} from '../../core/types';

/**
 * Adapter Zernio: WhatsApp oficial (Cloud API da Meta) via https://zernio.com, pensado para
 * número em COEXISTÊNCIA (o mesmo número no app WhatsApp Business e na API).
 *
 * @see docs/providers/zernio.md (dossiê) — convenções: payloads de webhook montados do schema
 * da doc (fixtures sintéticas); o que não foi confirmado em número real está marcado lá.
 */

const PROVIDER = 'zernio';
const DEFAULT_BASE_URL = 'https://zernio.com/api';
/** Header de assinatura do webhook: HMAC-SHA256 hex minúsculo do corpo bruto. */
export const ZERNIO_SIGNATURE_HEADER = 'x-zernio-signature';
const LEGACY_SIGNATURE_HEADER = 'x-late-signature';
export const ZERNIO_EVENT_ID_HEADER = 'x-zernio-event-id';

// ---------------------------------------------------------------------------
// portas (o gateway implementa com o banco dele)
// ---------------------------------------------------------------------------

/**
 * Porta telefone → `conversationId`. O Zernio é centrado em conversa: todo envio livre exige o
 * `conversationId`. O adapter ALIMENTA (`set`) a cada webhook e a cada resposta de envio de
 * template, e LÊ (`get`) antes de enviar. Se `get` não achar, o adapter consulta
 * `GET /v1/inbox/conversations/search`; sem conversa não há janela de 24 h aberta (WINDOW_CLOSED).
 * O padrão é em memória (perde tudo ao reiniciar); o gateway deve injetar uma versão persistente.
 */
export interface ZernioConversationStore {
  get(chatId: string): string | undefined | Promise<string | undefined>;
  set(chatId: string, conversationId: string): void | Promise<void>;
}

/**
 * Porta de dedupe por id do evento (`payload.id` = `X-Zernio-Event-Id`). `seen` marca e responde:
 * `true` se já tinha visto. SÍNCRONA porque `parseWebhook` é síncrono; um gateway com dedupe
 * assíncrono (banco) deve deduplicar ANTES de chamar o parse (use `zernioEventId(input)`) e passar
 * `dedupe: false`.
 */
export interface ZernioEventDedupe {
  seen(eventId: string): boolean;
}

export interface ZernioHistoryFilter {
  /**
   * OPCIONAL: idade máxima (ms) de `sentAt` para uma mensagem virar evento de conversa. Mais
   * velha vira `unknown` (`reason: "history_sync"`). Padrão: `0` (desligado), porque retries do
   * Zernio atrasam entregas legítimas por até ~51 h e perdê-las é pior que o risco coberto. O
   * filtro padrão é só por `source`. ATENÇÃO: o valor real de `metadata.source` do histórico
   * sincronizado ainda NÃO foi confirmado em número real (o dossiê assume `coexistence_history`,
   * visto na doc da leitura REST); se o `source` não bastar, ligue esta idade (ex.: 2 h).
   */
  maxAgeMs?: number;
  /** Valores de `metadata.source` tratados como histórico sincronizado. Padrão: `['coexistence_history']`. */
  historySources?: string[];
}

export interface ZernioOptions {
  /** API key do Zernio (Bearer). Nunca vai para mensagens de erro. */
  apiKey: string;
  /** `accountId` do número WhatsApp no Zernio (a "instância"). */
  accountId: string;
  /** Padrão `https://zernio.com/api`. */
  baseUrl?: string;
  /**
   * Segredo do endpoint de webhook (o mesmo cadastrado em `POST /v1/webhooks/settings`). Quando
   * definido, `parseWebhook` verifica `X-Zernio-Signature` ANTES de processar e falha fechado
   * (assinatura ausente/inválida/sem `rawBody` vira `unknown`). Opt-in, como na wuzapi.
   */
  webhookSecret?: string;
  conversations?: ZernioConversationStore;
  /** `false` desliga o dedupe interno (quando o gateway deduplica antes). Padrão: memória, 72 h. */
  dedupe?: ZernioEventDedupe | false;
  history?: ZernioHistoryFilter;
  timeoutMs?: number;
  retries?: number;
  fetch?: typeof globalThis.fetch;
}

/** Saúde do número (para o job de saúde do gateway). */
export interface ZernioNumberHealth {
  state: InstanceState;
  /** `GREEN` | `YELLOW` | `RED` | `UNKNOWN`. */
  qualityRating?: string;
  /** Ex.: `TIER_250`, `TIER_1K`, `TIER_UNLIMITED`. */
  messagingLimitTier?: string;
  /** `STANDARD` | `HIGH`. */
  throughputLevel?: string;
  /** Status bruto da Meta (ex.: `CONNECTED`). */
  phoneStatus?: string;
  platformType?: string;
  displayPhoneNumber?: string;
  raw: unknown;
}

export interface ZernioAdapter extends WaAdapter {
  /** Saúde do número via `GET /v1/whatsapp/number-info`. Lança em erro (ao contrário de `status`). */
  health(): Promise<ZernioNumberHealth>;
}

const ZERNIO_CAPABILITIES: CapabilitySet = [
  'instance.status',
  'messages.sendText',
  'messages.sendMedia',
  'messages.sendReaction',
  'messages.sendLocation',
  'messages.sendContactCard',
  'messages.sendTemplate',
  'messages.download',
  'contacts.list',
  'contacts.get',
  'contacts.block',
  'contacts.unblock',
  'contacts.listBlocked',
  'chats.archive',
  'chats.unarchive',
  'chats.markRead',
  'presence.setTyping',
  'business.getProfile',
  'business.updateProfile',
  'webhooks.parse',
];

const DEFAULT_HISTORY_MAX_AGE_MS = 0;
const DEDUPE_TTL_MS = 72 * 60 * 60 * 1000;
const DEDUPE_MAX_ENTRIES = 50_000;
/** Limite do `POST /v1/media/upload-direct` na prática (doc: ~4,5 MB). */
const UPLOAD_DIRECT_MAX_BYTES = 4_500_000;

export function zernio(options: ZernioOptions): ZernioAdapter {
  const http = new HttpClient({
    baseUrl: options.baseUrl ?? DEFAULT_BASE_URL,
    headers: { authorization: `Bearer ${options.apiKey}` },
    timeoutMs: options.timeoutMs,
    retries: options.retries,
    secrets: [options.apiKey, ...(options.webhookSecret ? [options.webhookSecret] : [])],
    provider: PROVIDER,
    fetch: options.fetch,
  });
  const store = options.conversations ?? new MemoryConversationStore();
  const dedupe: ZernioEventDedupe | undefined =
    options.dedupe === false ? undefined : (options.dedupe ?? new MemoryEventDedupe());
  const ctx: Ctx = { http, options, store };

  const instance: InstanceApi = {
    // A conexão do número é um fluxo OAuth/Embedded Signup com o celular na mão (config v2 do
    // gateway); não há QR nem pairing code. Devolve só o `raw` explicativo (ADR-0002).
    connect: async () => ({
      raw: {
        supported: false,
        reason:
          'Zernio conecta o número por Embedded Signup (GET /v1/connect/whatsapp), fora do contrato de instância.',
      },
    }),
    status: () => statusInstance(ctx),
    logout: async () => {
      throw new WaConnectorError(
        'UNSUPPORTED_CAPABILITY',
        'Zernio não tem logout por API: desconectar a conta é configuração (DELETE /v1/accounts/{id}); sair da coexistência só no celular.',
        { provider: PROVIDER },
      );
    },
  };

  const messages: MessagesApi = {
    sendText: (input) => sendText(ctx, input),
    sendMedia: (input) => sendMedia(ctx, input),
    sendReaction: (input) => sendReaction(ctx, input),
    sendLocation: (input) => sendLocation(ctx, input),
    sendContactCard: (input) => sendContactCard(ctx, input),
    sendTemplate: (input) => sendTemplate(ctx, input),
    download: (input) => downloadMedia(ctx, input),
  };

  const contacts: ContactsApi = {
    list: () => listContacts(ctx),
    get: (chatId) => getContact(ctx, chatId),
    block: (chatId) => setBlocked(ctx, chatId, true),
    unblock: (chatId) => setBlocked(ctx, chatId, false),
    listBlocked: () => listBlocked(ctx),
  };

  const chats: ChatsApi = {
    archive: (chatId) => setArchived(ctx, chatId, true),
    unarchive: (chatId) => setArchived(ctx, chatId, false),
    markRead: (chatId) => markChatRead(ctx, chatId),
  };

  const presence: PresenceApi = {
    setTyping: (input) => setTyping(ctx, input),
  };

  const business: BusinessApi = {
    getProfile: () => getBusinessProfile(ctx),
    updateProfile: (input) => updateBusinessProfile(ctx, input),
  };

  const verify = (input: WebhookInput): WebhookVerification =>
    verifyZernioWebhook(input, options.webhookSecret);

  return {
    provider: PROVIDER,
    capabilities: ZERNIO_CAPABILITIES,
    instance,
    messages,
    groups: {},
    contacts,
    chats,
    presence,
    business,
    parseWebhook: (input) => parseZernioWebhook(input, ctx, dedupe, verify),
    verifyWebhook: verify,
    health: () => fetchHealth(ctx),
  };
}

interface Ctx {
  http: HttpClient;
  options: ZernioOptions;
  store: ZernioConversationStore;
}

// ---------------------------------------------------------------------------
// implementações em memória das portas
// ---------------------------------------------------------------------------

class MemoryConversationStore implements ZernioConversationStore {
  private readonly map = new Map<string, string>();
  get(chatId: string): string | undefined {
    return this.map.get(chatId);
  }
  set(chatId: string, conversationId: string): void {
    this.map.set(chatId, conversationId);
  }
}

class MemoryEventDedupe implements ZernioEventDedupe {
  private readonly seenAt = new Map<string, number>();
  seen(eventId: string): boolean {
    const now = Date.now();
    const previous = this.seenAt.get(eventId);
    if (previous !== undefined && now - previous < DEDUPE_TTL_MS) {
      return true;
    }
    this.seenAt.set(eventId, now);
    if (this.seenAt.size > DEDUPE_MAX_ENTRIES) {
      // Map preserva ordem de inserção: descarta os mais antigos.
      let excess = this.seenAt.size - DEDUPE_MAX_ENTRIES;
      for (const key of this.seenAt.keys()) {
        if (excess-- <= 0) break;
        this.seenAt.delete(key);
      }
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// erros
// ---------------------------------------------------------------------------

/** Traduz erros do Zernio/Meta para códigos canônicos; preserva status, body e providerCode. */
function mapError(error: unknown): unknown {
  if (!(error instanceof WaConnectorError)) return error;
  const body = asRecord(error.body);
  const platformError = asRecord(body?.platformError);
  const details = asRecord(platformError?.details);
  const providerCode =
    codeString(platformError?.code) ??
    codeString(body?.code) ??
    codeString(asRecord(body?.error)?.code);
  let code = error.code;
  if (providerCode === '131047' || providerCode === 'TEMPLATE_REQUIRED') {
    code = 'WINDOW_CLOSED';
  } else if (providerCode === '132001' || details?.phase === 'template_lookup') {
    code = 'TEMPLATE_NOT_FOUND';
  } else if (providerCode === '131026' || providerCode === '131021') {
    code = 'INVALID_RECIPIENT';
  } else if (providerCode === '131056') {
    code = 'RATE_LIMITED';
  } else if (
    providerCode === 'ACCOUNT_DISCONNECTED' ||
    providerCode === 'ads_connection_required' ||
    error.status === 409
  ) {
    code = 'INSTANCE_DISCONNECTED';
  }
  if (code === error.code && providerCode === undefined) return error;
  return new WaConnectorError(code, error.message, {
    provider: PROVIDER,
    status: error.status,
    retryAfterMs: error.retryAfterMs,
    cause: error,
    providerCode,
    body: error.body,
  });
}

function codeString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number') return String(value);
  return undefined;
}

async function call<T>(ctx: Ctx, request: Parameters<HttpClient['request']>[0]): Promise<T> {
  try {
    return await ctx.http.request<T>(request);
  } catch (error) {
    throw mapError(error);
  }
}

function invalidInput(message: string): WaConnectorError {
  return new WaConnectorError('INVALID_INPUT', message, { provider: PROVIDER });
}

// ---------------------------------------------------------------------------
// chatId e conversationId
// ---------------------------------------------------------------------------

/** `participantId` do Zernio: telefone só com dígitos e DDI; BSUID (sem telefone) fica como veio. */
function toParticipantId(chatId: string): string {
  const digits = chatId.replace(/\D+/g, '');
  return digits.length >= 7 && digits.length === chatId.replace(/^\+/, '').length
    ? digits
    : chatId.trim();
}

async function requireConversationId(ctx: Ctx, chatId: string): Promise<string> {
  const participantId = toParticipantId(chatId);
  const cached = await ctx.store.get(participantId);
  if (cached) return cached;

  const found = await call<unknown>(ctx, {
    path: '/v1/inbox/conversations/search',
    query: { query: participantId, accountId: ctx.options.accountId, platform: 'whatsapp' },
  });
  for (const item of asArray(asRecord(found)?.data)) {
    const conversation = asRecord(asRecord(item)?.conversation);
    const id = asString(conversation?.id);
    const candidate = asString(conversation?.participantId);
    if (id && candidate && toParticipantId(candidate) === participantId) {
      await ctx.store.set(participantId, id);
      return id;
    }
  }
  throw new WaConnectorError(
    'WINDOW_CLOSED',
    `Sem conversa com ${participantId} neste número: não há janela de 24 h aberta. Abra com messages.sendTemplate.`,
    { provider: PROVIDER, providerCode: 'NO_CONVERSATION' },
  );
}

// ---------------------------------------------------------------------------
// instância e saúde
// ---------------------------------------------------------------------------

function mapPhoneStatus(status: string | undefined): InstanceState {
  if (!status) return 'unknown';
  const normalized = status.toUpperCase();
  if (normalized === 'CONNECTED') return 'connected';
  if (
    ['DISCONNECTED', 'BANNED', 'FLAGGED', 'RESTRICTED', 'UNPAIRED', 'DELETED'].includes(normalized)
  ) {
    return 'disconnected';
  }
  if (['PENDING', 'MIGRATED', 'UNPAIRED_UNVERIFIED'].includes(normalized)) return 'connecting';
  return 'unknown';
}

async function fetchHealth(ctx: Ctx): Promise<ZernioNumberHealth> {
  const raw = await call<unknown>(ctx, {
    path: '/v1/whatsapp/number-info',
    query: { accountId: ctx.options.accountId },
  });
  const phone = asRecord(asRecord(raw)?.phone);
  const phoneStatus = asString(phone?.status);
  return {
    state: mapPhoneStatus(phoneStatus),
    qualityRating: asString(phone?.quality_rating),
    messagingLimitTier: asString(phone?.messaging_limit_tier),
    throughputLevel: asString(asRecord(phone?.throughput)?.level),
    phoneStatus,
    platformType: asString(phone?.platform_type),
    displayPhoneNumber: asString(phone?.display_phone_number),
    raw,
  };
}

/**
 * `status()`: Graph erro 100/subcode 33 (a Meta parou de servir o objeto: causa típica é a
 * desconexão feita no celular) vira `disconnected`; conta desconectada no Zernio (409) também.
 * Erros de credencial (401/403) e de rede PROPAGAM (não são estado da instância).
 */
async function statusInstance(ctx: Ctx): Promise<InstanceStatus> {
  try {
    const health = await fetchHealth(ctx);
    return { state: health.state, raw: health.raw };
  } catch (error) {
    if (error instanceof WaConnectorError) {
      const body = asRecord(error.body);
      const platformError = asRecord(body?.platformError);
      const graphGone =
        error.status === 400 &&
        (codeString(platformError?.code) === '100' || codeString(body?.code) === '100') &&
        codeString(platformError?.subcode ?? platformError?.error_subcode) === '33';
      if (graphGone || error.code === 'INSTANCE_DISCONNECTED') {
        return { state: 'disconnected', raw: error.body ?? { message: error.message } };
      }
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// mensagens
// ---------------------------------------------------------------------------

function sentFrom(chatId: string, response: unknown, fallbackId?: string): SentMessage {
  const data = asRecord(asRecord(response)?.data);
  const id = asString(data?.messageId) ?? fallbackId;
  if (!id) {
    throw new WaConnectorError('PROVIDER_ERROR', 'Resposta do Zernio sem data.messageId.', {
      provider: PROVIDER,
    });
  }
  return { id, chatId, timestamp: Date.now(), raw: response };
}

async function postMessage(
  ctx: Ctx,
  chatId: string,
  extra: Record<string, unknown>,
): Promise<SentMessage> {
  const conversationId = await requireConversationId(ctx, chatId);
  const response = await call<unknown>(ctx, {
    method: 'POST',
    path: `/v1/inbox/conversations/${encodeURIComponent(conversationId)}/messages`,
    headers: { 'idempotency-key': randomUUID() },
    // O mesmo Idempotency-Key vale em todos os retries do HttpClient: reenviar não duplica.
    idempotent: true,
    body: { accountId: ctx.options.accountId, ...extra },
  });
  return sentFrom(chatId, response);
}

function sendText(ctx: Ctx, input: SendTextInput): Promise<SentMessage> {
  return postMessage(ctx, input.to, {
    message: input.text,
    ...(input.quotedId ? { replyTo: input.quotedId } : {}),
  });
}

const ATTACHMENT_TYPES: Partial<Record<MediaKind, string>> = {
  image: 'image',
  video: 'video',
  audio: 'audio',
  document: 'file',
};

async function sendMedia(ctx: Ctx, input: SendMediaInput): Promise<SentMessage> {
  const attachmentType = ATTACHMENT_TYPES[input.media.kind];
  if (!attachmentType) {
    throw invalidInput(
      `Zernio/WhatsApp não envia mídia do tipo "${input.media.kind}" por este caminho.`,
    );
  }
  const url = input.media.url ?? (await uploadBase64(ctx, input.media));
  const isVoice = input.media.kind === 'audio' && (input.media.mimeType ?? '').includes('ogg');
  return postMessage(ctx, input.to, {
    attachmentUrl: url,
    attachmentType,
    ...(input.media.filename ? { attachmentName: input.media.filename } : {}),
    ...(isVoice ? { voiceNote: true } : {}),
    ...(input.caption ? { message: input.caption } : {}),
    ...(input.quotedId ? { replyTo: input.quotedId } : {}),
  });
}

/** Sobe base64 via `POST /v1/media/upload-direct` (multipart) e devolve a URL pública. */
async function uploadBase64(ctx: Ctx, media: MediaRef): Promise<string> {
  if (!media.base64) {
    throw invalidInput('sendMedia exige media.url ou media.base64.');
  }
  const bytes = Buffer.from(media.base64, 'base64');
  if (bytes.length > UPLOAD_DIRECT_MAX_BYTES) {
    throw invalidInput(
      `Mídia em base64 maior que ~4,5 MB (${bytes.length} bytes): hospede o arquivo e envie media.url.`,
    );
  }
  const form = new FormData();
  const mimeType = media.mimeType ?? 'application/octet-stream';
  form.append('file', new Blob([bytes], { type: mimeType }), media.filename ?? 'file');
  form.append('contentType', mimeType);
  const fetchImpl = ctx.options.fetch ?? globalThis.fetch;
  let response: Response;
  try {
    response = await fetchImpl(
      `${stripSlash(ctx.options.baseUrl ?? DEFAULT_BASE_URL)}/v1/media/upload-direct`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${ctx.options.apiKey}` },
        body: form,
      },
    );
  } catch (error) {
    throw new WaConnectorError('NETWORK_ERROR', 'Falha de rede no upload de mídia ao Zernio.', {
      provider: PROVIDER,
      cause: error,
    });
  }
  if (!response.ok) {
    throw new WaConnectorError(
      response.status === 401 || response.status === 403 ? 'AUTH_FAILED' : 'PROVIDER_ERROR',
      `Upload de mídia ao Zernio falhou: HTTP ${response.status}.`,
      { provider: PROVIDER, status: response.status },
    );
  }
  const url = asString(asRecord(await response.json().catch(() => undefined))?.url);
  if (!url) {
    throw new WaConnectorError('PROVIDER_ERROR', 'Upload ao Zernio sem "url" na resposta.', {
      provider: PROVIDER,
    });
  }
  return url;
}

async function sendReaction(ctx: Ctx, input: SendReactionInput): Promise<SentMessage> {
  const conversationId = await requireConversationId(ctx, input.to);
  const path = `/v1/inbox/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(input.messageId)}/reactions`;
  const response =
    input.emoji === ''
      ? await call<unknown>(ctx, {
          method: 'DELETE',
          path,
          query: { accountId: ctx.options.accountId },
        })
      : await call<unknown>(ctx, {
          method: 'POST',
          path,
          body: { accountId: ctx.options.accountId, emoji: input.emoji },
        });
  const record = asRecord(response);
  return {
    id: asString(record?.platformMessageId) ?? input.messageId,
    chatId: input.to,
    timestamp: Date.now(),
    raw: response,
  };
}

function sendLocation(ctx: Ctx, input: SendLocationInput): Promise<SentMessage> {
  return postMessage(ctx, input.to, {
    location: {
      latitude: input.latitude,
      longitude: input.longitude,
      ...(input.name ? { name: input.name } : {}),
      ...(input.address ? { address: input.address } : {}),
    },
  });
}

function sendContactCard(ctx: Ctx, input: SendContactCardInput): Promise<SentMessage> {
  return postMessage(ctx, input.to, {
    contacts: [
      {
        name: { formatted_name: input.contactName },
        phones: [{ phone: input.contactPhone, type: 'CELL' }],
      },
    ],
  });
}

/**
 * Template abre ou reaproveita a conversa (`POST /v1/inbox/conversations`): não precisa de
 * `conversationId` prévio e funciona dentro e fora da janela de 24 h. Guarda o `conversationId`
 * devolvido na porta.
 */
async function sendTemplate(ctx: Ctx, input: SendTemplateInput): Promise<SentMessage> {
  const participantId = toParticipantId(input.to);
  const response = await call<unknown>(ctx, {
    method: 'POST',
    path: '/v1/inbox/conversations',
    headers: { 'idempotency-key': randomUUID() },
    idempotent: true,
    body: {
      accountId: ctx.options.accountId,
      participantId,
      templateName: input.name,
      templateLanguage: input.language,
      templateParams: input.params ?? [],
      ...(input.buttonParams?.length ? { templateButtonParams: input.buttonParams } : {}),
    },
  });
  const conversationId = asString(asRecord(asRecord(response)?.data)?.conversationId);
  if (conversationId) await ctx.store.set(participantId, conversationId);
  return sentFrom(input.to, response);
}

/** Acha o `mediaId` na URL `…/v1/whatsapp/media/{mediaId}` de um anexo recebido. */
export function zernioMediaIdFromUrl(url: string): string | undefined {
  const marker = '/whatsapp/media/';
  const index = url.indexOf(marker);
  if (index < 0) return undefined;
  const rest = url.slice(index + marker.length);
  const end = rest.search(/[/?#]/);
  const id = end < 0 ? rest : rest.slice(0, end);
  return id.length > 0 ? id : undefined;
}

/**
 * `input.messageId` deve ser o `WaMessage.media.id` (= `mediaId`). Se `input.raw` (o `raw` do
 * `WaMessage` recebido) trouxer o anexo, o `mediaId` é extraído dele (e o mimeType aproveitado).
 * A Meta descarta mídia recebida após a retenção: nesse caso o Zernio responde 400 → MEDIA_EXPIRED.
 */
async function downloadMedia(ctx: Ctx, input: DownloadMediaInput): Promise<DownloadedMedia> {
  const attachment = firstAttachment(asRecord(input.raw));
  const mediaId =
    (attachment?.url ? zernioMediaIdFromUrl(attachment.url) : undefined) ?? input.messageId;
  try {
    const base64 = await ctx.http.request<string>({
      path: `/v1/whatsapp/media/${encodeURIComponent(mediaId)}`,
      query: { accountId: ctx.options.accountId },
      responseType: 'base64',
    });
    return { base64, mimeType: attachment?.mimeType, raw: { mediaId, bytesBase64: base64.length } };
  } catch (error) {
    if (error instanceof WaConnectorError && error.status === 400) {
      throw new WaConnectorError(
        'MEDIA_EXPIRED',
        'A mídia não está mais disponível (retenção da Meta vencida): baixe ao receber o webhook.',
        { provider: PROVIDER, status: 400, cause: error },
      );
    }
    throw mapError(error);
  }
}

function firstAttachment(
  raw: Record<string, unknown> | undefined,
): { url?: string; mimeType?: string } | undefined {
  const message = asRecord(raw?.message);
  const first = asRecord(asArray(message?.attachments)[0]);
  if (!first) return undefined;
  return { url: asString(first.url), mimeType: asString(first.mimeType) };
}

// ---------------------------------------------------------------------------
// contatos, bloqueio, chats, presença, perfil comercial
// ---------------------------------------------------------------------------

function mapCrmContact(item: Record<string, unknown>): Contact {
  return {
    id: asString(item.platformIdentifier) ?? asString(item.id) ?? '',
    name: asString(item.name),
    profilePictureUrl: asString(item.avatarUrl),
    hasWhatsApp: true,
    isBlocked: typeof item.isBlocked === 'boolean' ? item.isBlocked : undefined,
    raw: item,
  };
}

/** Lê o CRM do Zernio (não a agenda do WhatsApp; em coexistência a agenda do app é importada). */
async function listContacts(ctx: Ctx): Promise<Contact[]> {
  const out: Contact[] = [];
  let skip = 0;
  for (let page = 0; page < 5; page++) {
    const response = await call<unknown>(ctx, {
      path: '/v1/contacts',
      query: { accountId: ctx.options.accountId, platform: 'whatsapp', limit: 200, skip },
    });
    const record = asRecord(response);
    const items = asArray(record?.contacts);
    for (const item of items) {
      const contact = asRecord(item);
      if (contact) out.push(mapCrmContact(contact));
    }
    if (asRecord(record?.pagination)?.hasMore !== true || items.length === 0) break;
    skip += items.length;
  }
  return out;
}

async function getContact(ctx: Ctx, chatId: string): Promise<Contact> {
  const participantId = toParticipantId(chatId);
  const response = await call<unknown>(ctx, {
    path: '/v1/contacts',
    query: {
      accountId: ctx.options.accountId,
      platform: 'whatsapp',
      search: participantId,
      limit: 20,
    },
  });
  for (const item of asArray(asRecord(response)?.contacts)) {
    const contact = asRecord(item);
    const identifier = asString(contact?.platformIdentifier);
    if (contact && identifier && toParticipantId(identifier) === participantId) {
      return mapCrmContact(contact);
    }
  }
  throw new WaConnectorError(
    'INVALID_RECIPIENT',
    `Contato ${participantId} não encontrado no CRM do Zernio.`,
    {
      provider: PROVIDER,
    },
  );
}

async function setBlocked(ctx: Ctx, chatId: string, blocked: boolean): Promise<void> {
  const response = await call<unknown>(ctx, {
    method: blocked ? 'POST' : 'DELETE',
    path: '/v1/whatsapp/block-users',
    body: {
      accountId: ctx.options.accountId,
      users: [`+${toParticipantId(chatId).replace(/^\+/, '')}`],
    },
  });
  const failed = asArray(asRecord(response)?.failed);
  if (failed.length > 0) {
    throw new WaConnectorError(
      'PROVIDER_ERROR',
      `O Zernio não conseguiu ${blocked ? 'bloquear' : 'desbloquear'} o contato.`,
      { provider: PROVIDER, body: response },
    );
  }
}

async function listBlocked(ctx: Ctx): Promise<string[]> {
  const out: string[] = [];
  let after: string | undefined;
  for (let page = 0; page < 20; page++) {
    const response = await call<unknown>(ctx, {
      path: '/v1/whatsapp/block-users',
      query: { accountId: ctx.options.accountId, limit: 100, after },
    });
    const record = asRecord(response);
    for (const item of asArray(record?.blockedUsers)) {
      const id = asString(asRecord(item)?.waId);
      if (id) out.push(id);
    }
    after = asString(record?.nextCursor);
    if (!after) break;
  }
  return out;
}

async function setArchived(ctx: Ctx, chatId: string, archived: boolean): Promise<void> {
  const conversationId = await requireConversationId(ctx, chatId);
  await call<unknown>(ctx, {
    method: 'PUT',
    path: `/v1/inbox/conversations/${encodeURIComponent(conversationId)}`,
    body: { accountId: ctx.options.accountId, status: archived ? 'archived' : 'active' },
  });
}

/** Marca a conversa inteira como lida. Em coexistência o Zernio NÃO envia tique azul (o celular manda). */
async function markChatRead(ctx: Ctx, chatId: string): Promise<void> {
  const conversationId = await requireConversationId(ctx, chatId);
  await call<unknown>(ctx, {
    method: 'POST',
    path: `/v1/inbox/conversations/${encodeURIComponent(conversationId)}/read`,
    body: { accountId: ctx.options.accountId },
  });
}

/** WhatsApp só tem "digitando": `composing` e `recording` enviam o indicador; `paused` é no-op. */
async function setTyping(ctx: Ctx, input: SetTypingInput): Promise<void> {
  if (input.state === 'paused') return;
  const conversationId = await requireConversationId(ctx, input.to);
  await call<unknown>(ctx, {
    method: 'POST',
    path: `/v1/inbox/conversations/${encodeURIComponent(conversationId)}/typing`,
    body: { accountId: ctx.options.accountId },
  });
}

async function getBusinessProfile(ctx: Ctx): Promise<BusinessProfile> {
  const raw = await call<unknown>(ctx, {
    path: '/v1/whatsapp/business-profile',
    query: { accountId: ctx.options.accountId },
  });
  const profile = asRecord(asRecord(raw)?.businessProfile);
  const vertical = asString(profile?.vertical);
  return {
    description: asString(profile?.description) ?? asString(profile?.about),
    address: asString(profile?.address),
    email: asString(profile?.email),
    websites: asArray(profile?.websites).filter((w): w is string => typeof w === 'string'),
    categories: vertical ? [vertical] : undefined,
    raw,
  };
}

async function updateBusinessProfile(ctx: Ctx, input: UpdateBusinessProfileInput): Promise<void> {
  await call<unknown>(ctx, {
    method: 'POST',
    path: '/v1/whatsapp/business-profile',
    body: {
      accountId: ctx.options.accountId,
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.address !== undefined ? { address: input.address } : {}),
      ...(input.email !== undefined ? { email: input.email } : {}),
    },
  });
}

// ---------------------------------------------------------------------------
// webhook: verificação HMAC
// ---------------------------------------------------------------------------

/**
 * Confere `X-Zernio-Signature`: HMAC-SHA256 (hex minúsculo) do CORPO BRUTO com o segredo do
 * endpoint, em tempo constante. Pura; nunca lança.
 */
export function verifyZernioSignature(
  rawBody: string | Uint8Array,
  signature: string | undefined,
  secret: string,
): boolean {
  if (!secret || !signature) return false;
  try {
    const expected = Buffer.from(
      createHmac('sha256', secret).update(rawBody).digest('hex'),
      'utf8',
    );
    const received = Buffer.from(signature.trim().toLowerCase(), 'utf8');
    return expected.length === received.length && timingSafeEqual(expected, received);
  } catch {
    return false;
  }
}

function verifyZernioWebhook(input: WebhookInput, secret: string | undefined): WebhookVerification {
  if (!secret) {
    return { valid: false, reason: 'webhookSecret não configurado no adapter zernio.' };
  }
  if (input.rawBody === undefined) {
    return {
      valid: false,
      reason:
        'webhookSecret configurado, mas WebhookInput.rawBody não foi fornecido: a verificação exige o corpo bruto. Falhando fechado.',
    };
  }
  const signature =
    headerValue(input.headers, ZERNIO_SIGNATURE_HEADER) ??
    headerValue(input.headers, LEGACY_SIGNATURE_HEADER);
  if (signature === undefined) {
    return { valid: false, reason: `Header "${ZERNIO_SIGNATURE_HEADER}" ausente no webhook.` };
  }
  if (!verifyZernioSignature(input.rawBody, signature, secret)) {
    return { valid: false, reason: `Assinatura "${ZERNIO_SIGNATURE_HEADER}" inválida.` };
  }
  return { valid: true };
}

function headerValue(headers: WebhookInput['headers'], name: string): string | undefined {
  if (!headers) return undefined;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name) continue;
    return Array.isArray(value) ? value[0] : value;
  }
  return undefined;
}

/** Id do evento (para o gateway deduplicar antes do parse): `X-Zernio-Event-Id` ou `payload.id`. */
export function zernioEventId(input: WebhookInput): string | undefined {
  return headerValue(input.headers, ZERNIO_EVENT_ID_HEADER) ?? asString(asRecord(input.body)?.id);
}

// ---------------------------------------------------------------------------
// webhook: eventos canônicos
// ---------------------------------------------------------------------------

function unknownEvent(raw: unknown, reason: string, instanceId?: string): UnknownEvent {
  return { type: 'unknown', provider: PROVIDER, instanceId, raw, reason };
}

/**
 * PONTO ÚNICO de classificação de origem do eco (ADR-0022): se o gateway adotar outro vocabulário
 * (ex.: `message.sent.external`), só esta função e o `origin` emitido abaixo mudam.
 */
export function classifySentOrigin(payload: Record<string, unknown>): SentOrigin {
  const source = asString(payload.source);
  if (source === 'whatsapp_business_app') return 'external_device';
  if (source === 'cloud_api') return 'self';
  if (source === 'meta_business_agent') return 'unknown';
  return asString(payload.sentVia) ? 'self' : 'unknown';
}

function parseZernioWebhook(
  input: WebhookInput,
  ctx: Ctx,
  dedupe: ZernioEventDedupe | undefined,
  verify: (input: WebhookInput) => WebhookVerification,
): CanonicalEvent[] {
  const body = asRecord(input.body);
  if (!body) return [unknownEvent(input.body, 'payload não é um objeto JSON')];

  if (ctx.options.webhookSecret) {
    const verification = verify(input);
    if (!verification.valid) {
      return [
        unknownEvent(input.body, `assinatura não verificada: ${verification.reason ?? 'inválida'}`),
      ];
    }
  }

  const eventName = asString(body.event);
  if (!eventName) return [unknownEvent(input.body, 'payload sem campo "event"')];

  const eventId = zernioEventId(input);
  if (dedupe && eventId && dedupe.seen(eventId)) {
    return [unknownEvent(input.body, 'duplicate_event')];
  }

  try {
    return mapEvent(eventName, body, ctx);
  } catch {
    return [unknownEvent(input.body, `falha ao mapear "${eventName}"`)];
  }
}

function mapEvent(eventName: string, body: Record<string, unknown>, ctx: Ctx): CanonicalEvent[] {
  const account = asRecord(body.account);
  const instanceId = asString(account?.accountId) ?? asString(account?.id);
  const conversation = asRecord(body.conversation);
  const chatId = participantChatId(conversation);

  // Alimenta a porta telefone → conversationId com tudo que o webhook revela.
  const conversationId = asString(conversation?.id);
  if (chatId && conversationId) {
    void Promise.resolve(ctx.store.set(chatId, conversationId)).catch(() => undefined);
  }

  switch (eventName) {
    case 'message.received':
    case 'message.sent': {
      const raw = asRecord(body.message);
      if (!raw || !chatId)
        return [unknownEvent(body, `${eventName} sem message/conversation`, instanceId)];
      const message = mapMessage(raw, body, chatId, eventName === 'message.sent');
      const historyReason = historyReasonFor(body, message.timestamp, ctx);
      if (historyReason) return [unknownEvent(body, historyReason, instanceId)];
      if (eventName === 'message.received') {
        return [{ type: 'message.received', provider: PROVIDER, instanceId, message, raw: body }];
      }
      return [
        {
          type: 'message.sent',
          provider: PROVIDER,
          instanceId,
          message,
          origin: classifySentOrigin(body),
          raw: body,
        },
      ];
    }
    case 'message.delivered':
    case 'message.read':
    case 'message.played':
    case 'message.failed': {
      const raw = asRecord(body.message);
      const messageId = asString(raw?.platformMessageId);
      if (!messageId) return [unknownEvent(body, `${eventName} sem platformMessageId`, instanceId)];
      const ack: MessageAck =
        eventName === 'message.delivered'
          ? 'delivered'
          : eventName === 'message.read'
            ? 'read'
            : eventName === 'message.played'
              ? 'played'
              : 'error';
      const event: MessageAckEvent = {
        type: 'message.ack',
        provider: PROVIDER,
        instanceId,
        messageId,
        chatId,
        ack,
        raw: body,
      };
      return [event];
    }
    case 'reaction.received': {
      const reaction = asRecord(body.reaction);
      const target = asString(reaction?.platformMessageId);
      if (!reaction || !target || !chatId) {
        return [unknownEvent(body, 'reaction.received incompleto', instanceId)];
      }
      const senderId = asString(asRecord(reaction.sender)?.id) ?? '';
      // Quando quem reage não é o participante da conversa, é o próprio negócio.
      const fromMe = senderId !== '' && toParticipantId(senderId) !== chatId;
      const message: WaMessage = {
        id: asString(reaction.messageId) ?? asString(body.id) ?? target,
        chatId,
        from: fromMe ? undefined : chatId,
        fromMe,
        timestamp: Date.parse(asString(reaction.reactedAt) ?? '') || Date.now(),
        kind: 'reaction',
        reaction: { emoji: asString(reaction.emoji) ?? '', targetMessageId: target },
        raw: body,
      };
      return [
        fromMe
          ? {
              type: 'message.sent',
              provider: PROVIDER,
              instanceId,
              message,
              origin: 'unknown',
              raw: body,
            }
          : { type: 'message.received', provider: PROVIDER, instanceId, message, raw: body },
      ];
    }
    case 'message.edited': {
      const raw = asRecord(body.message);
      if (!raw || !chatId)
        return [unknownEvent(body, 'message.edited sem message/conversation', instanceId)];
      const fromMe = asString(raw.direction) === 'outgoing';
      const history = asArray(body.editHistory)
        .map((entry) => asString(asRecord(entry)?.text))
        .filter((text): text is string => text !== undefined);
      return [
        {
          type: 'message.edited',
          provider: PROVIDER,
          instanceId,
          message: mapMessage(raw, body, chatId, fromMe),
          previousTexts: history,
          editedAt: Date.parse(asString(body.editedAt) ?? '') || undefined,
          raw: body,
        },
      ];
    }
    case 'message.deleted': {
      const raw = asRecord(body.message);
      const messageId = asString(raw?.platformMessageId);
      if (!raw || !messageId || !chatId) {
        return [unknownEvent(body, 'message.deleted sem message/conversation', instanceId)];
      }
      const fromMe = asString(raw.direction) === 'outgoing';
      return [
        {
          type: 'message.deleted',
          provider: PROVIDER,
          instanceId,
          messageId,
          chatId,
          fromMe,
          deletedAt: Date.parse(asString(body.deletedAt) ?? '') || undefined,
          message: mapMessage(raw, body, chatId, fromMe),
          raw: body,
        },
      ];
    }
    case 'account.connected':
    case 'account.recovered':
      return [connectionEvent(instanceId, 'connected', body)];
    case 'account.disconnected':
    case 'account.restricted':
      return [connectionEvent(instanceId, 'disconnected', body)];
    case 'whatsapp.account.status_updated': {
      const text = JSON.stringify(body).toLowerCase();
      if (/disabled|restricted|deleted|disconnected|banned/.test(text)) {
        return [connectionEvent(instanceId, 'disconnected', body)];
      }
      if (/reinstated|connected|active/.test(text)) {
        return [connectionEvent(instanceId, 'connected', body)];
      }
      return [unknownEvent(body, eventName, instanceId)];
    }
    default:
      // edited/deleted/conversation.*/template/identity/call...: preservados em `raw` (dossiê).
      return [unknownEvent(body, eventName, instanceId)];
  }
}

function connectionEvent(
  instanceId: string | undefined,
  state: InstanceState,
  raw: unknown,
): ConnectionUpdateEvent {
  return { type: 'connection.update', provider: PROVIDER, instanceId, state, raw };
}

/** `chatId` canônico = participante da conversa (NUNCA `message.sender` em `message.sent`). */
function participantChatId(conversation: Record<string, unknown> | undefined): string | undefined {
  const id = asString(conversation?.participantId);
  return id ? toParticipantId(id) : undefined;
}

function historyReasonFor(
  body: Record<string, unknown>,
  timestamp: number,
  ctx: Ctx,
): string | undefined {
  const sources = ctx.options.history?.historySources ?? ['coexistence_history'];
  const metadata = asRecord(body.metadata);
  const source = asString(metadata?.source) ?? asString(body.source);
  if (source && sources.includes(source)) return 'history_sync';
  const maxAge = ctx.options.history?.maxAgeMs ?? DEFAULT_HISTORY_MAX_AGE_MS;
  if (maxAge > 0 && Number.isFinite(timestamp) && Date.now() - timestamp > maxAge) {
    return 'history_sync';
  }
  return undefined;
}

const KIND_BY_ATTACHMENT: Record<string, MediaKind> = {
  image: 'image',
  video: 'video',
  audio: 'audio',
  file: 'document',
  document: 'document',
  sticker: 'sticker',
};

function mapMessage(
  raw: Record<string, unknown>,
  body: Record<string, unknown>,
  chatId: string,
  fromMe: boolean,
): WaMessage {
  const metadata = asRecord(body.metadata);
  const attachment = asRecord(asArray(raw.attachments)[0]);
  const attachmentType = asString(attachment?.type);
  const mediaKind = attachmentType ? KIND_BY_ATTACHMENT[attachmentType] : undefined;
  const sender = asRecord(raw.sender);

  let kind: MessageKind = 'text';
  if (mediaKind) kind = mediaKind;
  else if (metadata?.location) kind = 'location';
  else if (metadata?.contacts) kind = 'contact';
  else if (asString(raw.text) === null || asString(raw.text) === undefined) kind = 'unknown';

  let media: MediaRef | undefined;
  if (attachment && mediaKind) {
    const url = asString(attachment.url);
    const mediaId = url ? zernioMediaIdFromUrl(url) : undefined;
    media = {
      kind: mediaKind,
      mimeType: asString(attachment.mimeType),
      // Inbound WhatsApp aponta para endpoint autenticado do Zernio: expõe só o id (use download).
      // Outbound é a URL pública enviada por quem mandou.
      ...(mediaId ? { id: mediaId } : url ? { url } : {}),
    };
  }

  const phone = asString(sender?.phoneNumber);
  return {
    id: asString(raw.platformMessageId) ?? asString(raw.id) ?? '',
    chatId,
    from: fromMe
      ? undefined
      : phone
        ? toParticipantId(phone)
        : (asString(sender?.businessScopedUserId) ?? asString(sender?.id)),
    fromMe,
    timestamp: Date.parse(asString(raw.sentAt) ?? '') || Date.now(),
    kind,
    text: asString(raw.text),
    media,
    quotedId: asString(metadata?.quotedMessageId),
    raw: body,
  };
}

// ---------------------------------------------------------------------------
// helpers de tipo
// ---------------------------------------------------------------------------

function stripSlash(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end--;
  return value.slice(0, end);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
