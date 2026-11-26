# ADR-0022: `messages.sendTemplate`, origem da mensagem enviada e erros tipados de janela/mídia

Status: aceita (fork BF Labs, aprovada pelo CEO em 2026-11-26)

## Contexto

Provedores que usam a API oficial da Meta (WABA direto, Zernio) têm o conceito de **template
aprovado**: é o único jeito de abrir conversa e de falar fora da janela de 24 h. Os provedores
não oficiais (wuzapi, uazapi...) não têm isso. Além disso, em número com o app WhatsApp Business
em coexistência, o celular gera eco de mensagens (`fromMe`) que não foram enviadas pelo conector.

## Decisão

1. Capability `messages.sendTemplate` e `SendTemplateInput` (`to`, `name`, `language`,
   `params[]` posicionais planos, `buttonParams[]`). Adapters sem suporte simplesmente não a
   declaram (`UnsupportedCapabilityError`).
2. `MessageSentEvent.origin?: 'self' | 'external_device' | 'unknown'` (opcional, aditivo).
3. Códigos de erro `WINDOW_CLOSED`, `TEMPLATE_NOT_FOUND`, `MEDIA_EXPIRED`.
4. `WaConnectorError.providerCode` e `.body` (corpo do erro do provider; `HttpClient` preenche
   `body`). O corpo **não** é redigido: não logar sem passar por `redactSecrets`.

## Política que NÃO fica no conector

A decisão "texto livre ou template" depende do estado da janela de 24 h (última mensagem do
cliente), que é política do gateway. O adapter só expõe o erro tipado `WINDOW_CLOSED` quando o
provider recusa.

## Consequências

Mudança 100% aditiva (novo membro de unions, campos opcionais); sem quebra para consumidores.
