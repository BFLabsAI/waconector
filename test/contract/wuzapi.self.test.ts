import { describe, expect, it } from 'vitest';
import { createConnector } from '../../src';
import { wuzapi } from '../../src/adapters/wuzapi';
import pairFixture from '../../src/adapters/wuzapi/fixtures/webhook-pair-success.json';
import pairLidFixture from '../../src/adapters/wuzapi/fixtures/webhook-pair-success-lid.json';

type Reply = { status: number; body: unknown };

function build(replies: Record<string, Reply>) {
  const paths: string[] = [];
  const wa = createConnector(
    wuzapi({
      baseUrl: 'https://wuzapi.exemplo.test',
      token: 'token-de-teste-nao-real',
      retries: 0,
      fetch: async (input) => {
        const path = new URL(String(input)).pathname;
        paths.push(path);
        const reply = replies[path] ?? { status: 500, body: { error: 'inesperado' } };
        return new Response(JSON.stringify(reply.body), {
          status: reply.status,
          headers: { 'content-type': 'application/json' },
        });
      },
    }),
  );
  return { wa, paths };
}

const STATUS: Reply = {
  status: 200,
  body: {
    code: 200,
    success: true,
    data: {
      connected: true,
      loggedIn: true,
      jid: '5511900000099:12@s.whatsapp.net',
      name: 'Instancia Fixture',
      token: 'SEGREDO-NAO-VAZAR',
      proxy_url: 'http://usuario:senha@proxy.exemplo.invalid:8080',
    },
  },
};

describe('wuzapi: LID da própria instância', () => {
  it('PairSuccess expõe selfJid/selfLid sem aparelho no connection.update', () => {
    const wa = build({}).wa;
    expect(wa.webhooks.parse({ body: pairLidFixture })[0]).toMatchObject({
      type: 'connection.update',
      state: 'connected',
      selfJid: '5511900000099@s.whatsapp.net',
      selfLid: '100000000000099@lid',
    });
  });

  it('PairSuccess sem LID continua conectado, só com selfJid', () => {
    const event = build({}).wa.webhooks.parse({ body: pairFixture })[0];
    expect(event).toMatchObject({
      type: 'connection.update',
      state: 'connected',
      selfJid: '5511999990000@s.whatsapp.net',
    });
    expect(event && 'selfLid' in event ? event.selfLid : undefined).toBeUndefined();
  });

  it('instance.getSelf junta /session/status e /user/lid/<dígitos>, sem vazar credenciais no raw', async () => {
    const { wa, paths } = build({
      '/session/status': STATUS,
      '/user/lid/5511900000099': {
        status: 200,
        body: {
          code: 200,
          success: true,
          data: { jid: '5511900000099@s.whatsapp.net', lid: '100000000000099@lid' },
        },
      },
    });
    const self = await wa.instance.getSelf();
    expect(paths).toEqual(['/session/status', '/user/lid/5511900000099']);
    expect(self).toMatchObject({
      jid: '5511900000099@s.whatsapp.net',
      phone: '5511900000099',
      lid: '100000000000099@lid',
      name: 'Instancia Fixture',
    });
    expect(JSON.stringify(self.raw)).not.toContain('SEGREDO-NAO-VAZAR');
    expect(JSON.stringify(self.raw)).not.toContain('proxy');
  });

  it('LID ainda não conhecido (404) devolve identidade sem lid', async () => {
    const { wa } = build({
      '/session/status': STATUS,
      '/user/lid/5511900000099': { status: 404, body: { code: 404, error: 'LID not found' } },
    });
    const self = await wa.instance.getSelf();
    expect(self.phone).toBe('5511900000099');
    expect(self.lid).toBeUndefined();
  });

  it('instância sem jid (desconectada) não consulta o LID', async () => {
    const { wa, paths } = build({
      '/session/status': {
        status: 200,
        body: { code: 200, success: true, data: { connected: false, loggedIn: false, jid: '' } },
      },
    });
    const self = await wa.instance.getSelf();
    expect(paths).toEqual(['/session/status']);
    expect(self.jid).toBeUndefined();
    expect(self.lid).toBeUndefined();
  });

  it('erro HTTP diferente de 404 no /user/lid propaga', async () => {
    const { wa } = build({
      '/session/status': STATUS,
      '/user/lid/5511900000099': { status: 500, body: { code: 500, error: 'boom' } },
    });
    await expect(wa.instance.getSelf()).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
  });
});
