# ADR-0023: eventos canônicos `message.edited` e `message.deleted`

Status: aceita (fork BF Labs, aprovada pelo CEO em 2026-11-26)

## Contexto

Providers com API oficial (Zernio) reportam edição e exclusão de mensagem pelo contato e, em
coexistência, pelo celular do negócio. O chat de multiatendimento precisa refletir isso.

## Decisão

Dois eventos novos e aditivos em `CanonicalEvent`:
`message.edited` (`message` com o texto mais recente, `previousTexts?`, `editedAt?`) e
`message.deleted` (`messageId`, `chatId`, `fromMe`, `deletedAt?`, `message?`).

Adapters que não emitem esses eventos não mudam: continuam produzindo `unknown` para o que não
reconhecem. Consumidores que fazem `switch` exaustivo em `event.type` precisam tratar os dois casos novos.
