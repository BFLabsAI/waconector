---
'waconector': minor
---

`MarkMessageReadInput` ganha `senderId?` (autor da mensagem). wuzapi: envia-o como `SenderPhone` em `POST /chat/markread` (necessário ao recibo de leitura em grupo); `ChatPhone` e `Id[]` seguem como antes.
