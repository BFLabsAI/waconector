import { zernio } from '../../src/adapters/zernio';
import { describeAdapterContract } from './adapter-contract';
import { fixture, happyRoutes, mockFetch } from './zernio-helpers';

describeAdapterContract({
  name: 'zernio',
  create: () => ({
    adapter: zernio({
      apiKey: 'chave-de-teste-nao-real',
      accountId: 'acc00000000000000000001',
      history: { maxAgeMs: 0 },
      fetch: mockFetch(happyRoutes()),
    }),
    ready: async () => {},
    webhooks: { messageReceived: { body: fixture('webhook-message-received-text.json') } },
    recipient: '15550100001',
  }),
});
