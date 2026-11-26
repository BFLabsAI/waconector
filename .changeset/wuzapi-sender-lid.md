---
'waconector': minor
---

wuzapi: o remetente (`WaMessage.from`) agora é resolvido para telefone (`sender_pn`, `Info.SenderAlt`, `Info.Sender`, `Info.Chat`) quando `Info.Sender` vem como `@lid`; novos campos aditivos `WaMessage.fromLid` e `WaMessage.isGroup`.
