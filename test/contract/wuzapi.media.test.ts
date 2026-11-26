import { describe, expect, it } from 'vitest';
import { createConnector } from '../../src';
import { wuzapi } from '../../src/adapters/wuzapi';
import pttFixture from '../../src/adapters/wuzapi/fixtures/webhook-message-audio-ptt.json';
import audioS3Fixture from '../../src/adapters/wuzapi/fixtures/webhook-message-audio-s3.json';
import imageS3Fixture from '../../src/adapters/wuzapi/fixtures/webhook-message-image-s3.json';

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

describe('wuzapi: mídia recebida via bloco s3 do webhook', () => {
  it('normaliza url/mimeType/filename/size/id a partir do s3, sem exigir base64', () => {
    const message = firstMessage(imageS3Fixture);
    expect(message.kind).toBe('image');
    expect(message.text).toBe('Foto de teste');
    expect(message.media).toEqual({
      kind: 'image',
      url: imageS3Fixture.s3.url,
      base64: undefined,
      mimeType: 'image/jpeg',
      filename: 'foto-teste.jpg',
      size: 48219,
      id: imageS3Fixture.s3.key,
    });
    expect(message.raw).toEqual(imageS3Fixture);
  });

  it('o s3 tem precedência sobre o mimetype do protobuf (audio com codecs)', () => {
    const message = firstMessage(audioS3Fixture);
    expect(message.kind).toBe('audio');
    expect(message.media?.mimeType).toBe('audio/ogg');
    expect(message.media?.url).toBe(audioS3Fixture.s3.url);
    expect(message.media?.size).toBe(9120);
  });

  it('continua aceitando base64 na raiz (media_delivery base64/both)', () => {
    const body = structuredClone(imageS3Fixture) as Record<string, unknown>;
    body.s3 = undefined;
    body.base64 = 'ZmFrZQ==';
    body.mimeType = 'image/png';
    body.fileName = 'raiz.png';
    const message = firstMessage(body);
    expect(message.media?.base64).toBe('ZmFrZQ==');
    expect(message.media?.mimeType).toBe('image/jpeg');
    expect(message.media?.filename).toBe('raiz.png');
    expect(message.media?.size).toBe(48219);
  });

  it('s3 + base64 (both) preenche os dois', () => {
    const body = structuredClone(imageS3Fixture) as Record<string, unknown>;
    body.base64 = 'ZmFrZQ==';
    const message = firstMessage(body);
    expect(message.media?.base64).toBe('ZmFrZQ==');
    expect(message.media?.url).toBe(imageS3Fixture.s3.url);
  });

  it('sem s3 nem base64, mantém o descritor do protobuf (útil para messages.download)', () => {
    const body = structuredClone(imageS3Fixture) as Record<string, unknown>;
    body.s3 = undefined;
    const message = firstMessage(body);
    expect(message.media?.kind).toBe('image');
    expect(message.media?.mimeType).toBe('image/jpeg');
    expect(message.media?.size).toBe(48219);
    expect(message.media?.url).toBe('https://mmg.exemplo.test/cifrado/abc.enc');
  });

  it('modo form (jsonData string) também expõe o s3', () => {
    const { userID, instanceName, ...event } = imageS3Fixture;
    const message = firstMessage({ jsonData: JSON.stringify(event), userID, instanceName });
    expect(message.media?.url).toBe(imageS3Fixture.s3.url);
  });
});

describe('wuzapi: nota de voz (audioMessage.PTT)', () => {
  it('PTT=true marca media.voice=true, mantendo kind "audio"', () => {
    const message = firstMessage(pttFixture);
    expect(message.kind).toBe('audio');
    expect(message.media?.kind).toBe('audio');
    expect(message.media?.voice).toBe(true);
  });

  it('áudio comum (sem PTT) fica com media.voice=false', () => {
    const body = structuredClone(pttFixture) as {
      event: { Message: { audioMessage: Record<string, unknown> } };
    };
    body.event.Message.audioMessage.PTT = undefined;
    expect(firstMessage(body).media?.voice).toBe(false);
  });
});
