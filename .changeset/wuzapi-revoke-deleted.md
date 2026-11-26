---
'waconector': patch
---

wuzapi: ProtocolMessage REVOKE recebido vira o evento canônico `message.deleted` (`messageId` = id da mensagem alvo, `chatId`, `fromMe`, `deletedAt`) em vez de `unknown`.
