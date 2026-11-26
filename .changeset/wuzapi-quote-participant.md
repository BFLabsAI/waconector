---
'waconector': minor
---

`SendTextInput` e `SendMediaInput` ganham `quotedParticipant?` (autor da mensagem citada). wuzapi: usa-o em `ContextInfo.Participant`; sem ele só assume o chat em conversa 1:1, e em grupo envia sem citação (antes mandava o JID do grupo como autor).
