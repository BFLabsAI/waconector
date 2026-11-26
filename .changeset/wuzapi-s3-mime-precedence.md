---
'waconector': patch
---

wuzapi: com bloco `s3`, `mimeType`/`filename`/`size` seguem a precedência submensagem do protobuf > `s3` > raiz (antes o `s3` vencia e perdia `codecs=opus` e o nome original do documento); nome sem extensão ganha a extensão do mimetype.
