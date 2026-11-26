---
'waconector': patch
---

wuzapi: sem bloco `s3` nem `base64`, `media.url` fica indefinida (a URL do CDN do WhatsApp é cifrada e inútil; o descritor continua em `raw` para `messages.download`); mídia recebida sem nome ganha `filename` `anexo-<id><ext>`.
