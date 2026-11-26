import { describe, expect, it } from 'vitest';
import { createConnector } from '../../src';
import { wuzapi } from '../../src/adapters/wuzapi';
import pttFixture from '../../src/adapters/wuzapi/fixtures/webhook-message-audio-ptt.json';
import audioS3Fixture from '../../src/adapters/wuzapi/fixtures/webhook-message-audio-s3.json';
import documentS3Fixture from '../../src/adapters/wuzapi/fixtures/webhook-message-document-s3.json';
import documentNoExtFixture from '../../src/adapters/wuzapi/fixtures/webhook-message-document-sem-extensao.json';
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

  it('a submensagem do protobuf tem precedência sobre o s3 (audio com codecs)', () => {
    const message = firstMessage(audioS3Fixture);
    expect(message.kind).toBe('audio');
    expect(message.media?.mimeType).toBe(audioS3Fixture.event.Message.audioMessage.mimetype);
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

describe('wuzapi: precedência submensagem > s3 > raiz (mimeType/fileName)', () => {
  it('nota de voz: mimetype com codecs vence o do s3; nome vem do s3 (a submensagem não tem)', () => {
    const media = firstMessage(pttFixture).media;
    expect(media?.mimeType).toBe('audio/ogg; codecs=opus');
    expect(media?.filename).toBe('FIXT-AUDIO-0001.ogg');
    expect(media?.url).toBe(pttFixture.s3.url);
    expect(media?.size).toBe(9100);
  });

  it('documento: fileName original da submensagem vence o nome sintético do s3', () => {
    const media = firstMessage(documentS3Fixture).media;
    expect(media?.filename).toBe('relatorio.pdf');
    expect(media?.mimeType).toBe('application/pdf');
    expect(media?.size).toBe(120400);
  });

  it('nome sem ponto ganha a extensão do mimetype', () => {
    const media = firstMessage(documentNoExtFixture).media;
    expect(media?.filename).toBe('contrato-final.pdf');
    expect(media?.size).toBe(5300);
  });

  it('mimetype desconhecido não inventa extensão', () => {
    const body = structuredClone(documentNoExtFixture) as {
      event: { Message: { documentMessage: Record<string, unknown> } };
      s3: Record<string, unknown>;
    };
    body.event.Message.documentMessage.mimetype = 'application/x-desconhecido';
    expect(firstMessage(body).media?.filename).toBe('contrato-final');
  });
});
