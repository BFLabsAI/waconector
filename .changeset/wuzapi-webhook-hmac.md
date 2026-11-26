---
'waconector': minor
---

wuzapi: verificação HMAC-SHA256 do webhook (`x-hmac-signature`) via opção `webhookHmacKey`, `verifyWuzapiSignature()` exportada e `wa.webhooks.verify()`. No core, `WaAdapter.verifyWebhook?` (opcional), `WebhooksApi.verify` e o tipo `WebhookVerification` (aditivos).
