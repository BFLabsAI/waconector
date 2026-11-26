# Dossiê: Zernio (WhatsApp, API oficial da Meta em coexistência)

- Docs oficiais: <https://docs.zernio.com> (índice `llms.txt`, páginas `.mdx` em Markdown, OpenAPI em <https://zernio.com/openapi.json>, versão 1.834.1 lida em 2026-11-26)
- Base da API: `https://zernio.com/api` (rotas `/v1/...`)
- Versão testada: somente leitura de documentação e OpenAPI em 2026-11-26. **Nenhuma chamada real de mensageria foi feita**: os payloads são montados do schema da doc (fixtures sintéticas em `src/adapters/zernio/fixtures/`); itens [inferência] precisam de teste com número real.
- Hospedagem: SaaS multi-tenant. O Zernio é um BSP/gateway sobre a **Cloud API da Meta**: o número fica registrado na WABA do cliente e o Zernio fala com a Meta em nome dele. Não existe sessão pareada tipo WhatsApp Web.


> **Atualização (decisão do CEO, 2026-11-26)**: o filtro de histórico do adapter é, por padrão, só por `metadata.source` (`maxAgeMs: 0`, idade desligada e opcional). O valor real de `metadata.source` do histórico sincronizado **precisa ser confirmado no teste real** (a doc só cita `coexistence_history` na leitura REST). `message.edited` e `message.deleted` agora são eventos canônicos (ADR-0023).

## Legenda de confiança

Cada afirmação importante carrega uma etiqueta:

- **[doc]** vem da documentação pública ou do OpenAPI do Zernio.
- **[doc-conflito]** a documentação se contradiz; precisa de teste real.
- **[real]** veio de chamada real ao Zernio (nenhuma até agora).
- **[inferência]** conclusão nossa, não escrita na doc. Precisa ser confirmada no teste real.

## Autenticação

- Header `Authorization: Bearer <API key>` em toda chamada [doc]. A chave é criada no painel (`/dashboard/api-keys`) ou por `POST /v1/api-keys` [doc].
- Chaves pertencem a um **workspace**; o limite de taxa é por workspace, não por chave [doc].
- Chaves com escopo (`scope: "profiles"` + `profileIds`, `permission: "read"`, `disabledResourceGroups`) isolam clientes e dão só leitura. Para o gateway: uma chave com escopo no perfil do número e sem os grupos que não usamos (`ads`, `publishing`, `billing`) reduz o estrago de um vazamento [doc, recomendação nossa].
- Fluxos de conexão (OAuth/Embedded Signup) usam também o header `X-Connect-Token` de curta duração (15 min); não é usado em chamadas de uso [doc].
- Não há token por instância: **a "instância" é escolhida pelo `accountId` enviado no corpo/query**, sempre com a mesma chave [doc].

## Modelo de contas, perfis e "instâncias"

- **Workspace** (equipe): dono das chaves, do plano e do limite de taxa [doc].
- **Perfil** (`profileId`): agrupador de contas, com `externalId` opcional que volta nos webhooks (campo `profiles[]`) para roteamento multi-cliente [doc].
- **Conta** (`accountId`, 24 hex): um número de WhatsApp conectado (plataforma `whatsapp`). É o equivalente a uma **instância** do gateway. Um perfil pode ter vários números, cada um é uma conta; um número só pode estar vivo em um perfil [doc].
- **Conversa** (`conversationId`, 24 hex, estável por participante+conta): o Zernio é **centrado em conversa**, não em destinatário. Todo envio livre vai em `POST /v1/inbox/conversations/{conversationId}/messages`; só um template pode abrir conversa nova com um telefone [doc].
- **Mapeamento para o gateway**: `instance.id` do gateway → guarda `{accountId, profileId}` e a API key (ou referência a ela). `chatId` canônico (telefone E.164) → precisa ser resolvido para `conversationId` (ver desenho do adapter).
- Identidade do contato: o Zernio entrega o telefone (`phoneNumber`, E.164 com `+`; `sender.id` sem `+`) **ou** o `businessScopedUserId` (BSUID) quando o usuário do WhatsApp adotou username e não expõe telefone (rollout desde abril/2026) [doc]. O adapter não pode assumir que sempre há telefone.

## Conexão do número e coexistência

- `GET /v1/connect/whatsapp?profileId=&redirect_url=&onboarding=api|business_app` devolve `authUrl` (Embedded Signup da Meta). Alternativas: `signup=hosted` (página do Zernio com número pré-selecionado), `POST /v1/connect/whatsapp/credentials` (token de System User da Meta) e `POST /v1/connect/whatsapp/embedded-signup` [doc].
- **Coexistência** é o padrão quando `onboarding` é omitido: o número continua no app WhatsApp Business e passa a funcionar na API ao mesmo tempo. O passo extra é escanear um QR (mostrado pela Meta) com o celular. O número tem de estar ativo no **app WhatsApp Business** (o WhatsApp comum não serve) [doc].
- Isso é **configuração (v2)**, não uso (v1). O gateway só precisa do `accountId` já conectado.
- Sair da coexistência: só no celular (Configurações > Conta > Plataforma de negócios > Desconectar). Dispara `account.disconnected` em segundos, mas a notificação da Meta é "best effort": ausência do evento não prova que o canal está vivo [doc].

### O que a coexistência muda (tudo [doc] salvo indicação)

- Mensagens são espelhadas entre o app e a API. **Até 6 meses de histórico são sincronizados** na conexão, e os contatos do app são importados.
- **Mensagens enviadas pelo celular chegam como eco**: evento `message.sent` com `source: "whatsapp_business_app"` (e `sentVia: null`, "desconhecido, nunca tratar como humano"). Envios pela API vêm com `source: "cloud_api"` e `sentVia` preenchido (`api`, `human`, `broadcast`...).
- Ecos de coexistência **não trazem o contexto de citação** (`quotedMessageId` ausente mesmo que o WhatsApp mostre como resposta) [doc].
- **Correção em 2026-11-26 (releitura da doc oficial)**: `message.sent` de eco do app em coexistência pode vir sem corpo renderizável, com `metadata.unsupported {code, title, details, type}` (ex.: álbum, código 131051). O adapter trata como `kind: "unknown"` sem texto; o gateway não deve responder a isso. As demais páginas oficiais de WhatsApp (conexão, inbox, templates, mídia/limites, preços, webhooks) foram conferidas e não divergem do dossiê.
- Edições e exclusões feitas pelo contato ou pelo celular chegam (`message.edited`, `message.deleted`); a Meta só envia edições para números com o app (coexistência) [doc].
- O histórico é **reenviado pela Meta repetidamente** em números de coexistência; apagar a conversa no Zernio não impede a reimportação [doc]. A importação de histórico não emite `message.received`/`message.sent` de forma documentada para WhatsApp (a doc só afirma isso para Instagram/Facebook). Mídia de histórico pode gerar o log `message.media_download_failed` sem significar perda nova [doc]. **Risco: o adapter precisa tratar duplicatas e mensagens antigas** (filtrar por `sentAt` e dedupe por `platformMessageId`) [inferência].
- **Vazão fixa em 20 mensagens por segundo** [doc].
- **Não suportado em coexistência**: Groups API (grupos criados no app não sincronizam e não aparecem na API), chamadas de voz/vídeo pela API, desaparecimento de mensagens e "ver uma vez" são desligados nas conversas 1:1, listas de transmissão do app são desativadas, foto de perfil fica travada (gerenciar no app) [doc].
- **Leitura**: `POST /v1/inbox/conversations/{id}/read` **não envia confirmação de leitura (tique azul) em coexistência**, porque o app do celular é o dono do estado de leitura [doc].
- Meta Business Agent (IA da Meta) pode responder no número; mensagens chegam com `metadata.standby: true` e `conversation.control_changed` avisa quem responde. **Enviar qualquer mensagem tira o controle do agente**, então um bot que responde a tudo deve ignorar mensagens `standby` [doc].

## Janela de 24 horas e templates

- Mensagem livre (texto, mídia, interativo, localização) só dentro de **24 h após a última mensagem do cliente**. Fora da janela, e para abrir conversa, só **template aprovado** [doc]. Erro Meta `131047` = janela fechada [doc].
- **O Zernio não expõe o "expira em" da janela como campo**. O único dado é o último `message.received` (o adapter deve guardar o timestamp da última mensagem recebida por conversa; `GET .../messages?sortOrder=desc&limit=1` serve de fallback) [inferência]. Em coexistência, mensagens que o cliente mandou ao celular e foram sincronizadas contam para a janela da Meta; o efeito exato no Zernio precisa de teste real [inferência].
- Abrir conversa com template: `POST /v1/inbox/conversations` com `accountId`, `participantId` (telefone só dígitos, com DDI, sem `+`), `templateName`, `templateLanguage`, `templateParams` (array plano: variáveis de header de texto, depois corpo, depois botões URL dinâmicos), opcionais `templateButtonParams[]`, `templateCards[]` (carrossel) [doc]. Resposta `201`: `data.messageId` (wamid), `data.conversationId`, `data.participantId`.
- Template dentro de conversa existente: `POST .../messages` com `template.elements[0] = {name, language, components}` (formato de envio da Meta) [doc]. O Zernio resolve nome+idioma APPROVED antes de enviar; falha devolve `platform_api_error` com `platformError.details.phase = template_lookup` [doc].
- **Direct Send** (mensagem utilitária sem template, `category: "utility"` + `message`, só texto e interativos, só WABA elegível): erros `DIRECT_SEND_NOT_ELIGIBLE`, `DIRECT_SEND_LIMITED`, `DIRECT_SEND_BLOCKED` [doc].
- Sem template e sem Direct Send, `POST /v1/inbox/conversations` falha com `400 TEMPLATE_REQUIRED` [doc].
- Gestão de templates (v2): `GET/POST /v1/whatsapp/templates`, `GET/PATCH/DELETE /v1/whatsapp/templates/{templateName}` e `.../id/{templateId}`, biblioteca em `GET /v1/whatsapp/template-library`. Revisão da Meta leva até 24 h; evento `whatsapp.template.status_updated` [doc]. O nome do template é minúsculas/números/underscore; `en` não é `en_US` [doc].
- Cobrança (Meta cobra direto na WABA): template entregue, mensagens de serviço após as 1.000 gratuitas por mês por número; Zernio mede mensagens enviadas após 10.000 por mês. O payload de `message.sent/delivered/read` traz `pricing` e `billingConversation` [doc].

## Operações de uso (endpoints)

Todos com `Authorization: Bearer`. `{cid}` = `conversationId`.

| Operação | Endpoint | Observações |
| --- | --- | --- |
| Listar conversas | `GET /v1/inbox/conversations?accountId=&platform=whatsapp&updatedSince=&status=&limit<=100&cursor=` | `updatedSince` vira feed de mudanças (ordem `updatedAt` asc, `sync.nextUpdatedSince`) [doc]. Item: `id`, `participantId`, `participantName`, `businessScopedUserId`, `lastMessage`, `unreadCount`, `status`, `threadControl`, `metadata.ctwa_clid`. |
| Buscar conversas | `GET /v1/inbox/conversations/search?query=&accountId=` | `query` mín. 2 caracteres; casa por texto de mensagem **e** identidade (nome, username, telefone) [doc]. Serve para achar o `cid` de um telefone. |
| Obter conversa | `GET /v1/inbox/conversations/{cid}?accountId=` | [doc] |
| Abrir conversa (template/Direct Send) | `POST /v1/inbox/conversations` | Ver acima. `201` [doc]. |
| Arquivar/ativar | `PUT /v1/inbox/conversations/{cid}` `{accountId, status: active|archived}` | [doc] |
| Apagar conversa | `DELETE /v1/inbox/conversations/{cid}` | Só apaga o armazenado no Zernio; coexistência reimporta [doc]. |
| Listar mensagens | `GET /v1/inbox/conversations/{cid}/messages?accountId=&limit<=100&cursor=&sortOrder=asc|desc` | Fonte: armazenamento local do Zernio. Campos: `id` (wamid), `direction`, `message`, `attachments[]`, `deliveryStatus` (`sent|delivered|read|played|failed|deleted`), `deliveredAt`, `readAt`, `sentAt`, `deliveryError`, `reactions[]`, `isEdited`, `isDeleted`, `sentVia`, `metadata` [doc]. **Não marca como lido** (sem efeito colateral). |
| Enviar mensagem | `POST /v1/inbox/conversations/{cid}/messages` | Corpo JSON: `accountId` (obrigatório), `message`, `attachmentUrl`, `attachmentType` (`image|video|audio|file`), `attachmentName`, `voiceNote`, `linkPreview`, `replyTo` (wamid), `location{latitude,longitude,name,address}`, `contacts[]`, `buttons[]` (até 3, viram botões de resposta), `interactive{...}`, `template{elements[]}`, `category: "utility"`. Também `multipart/form-data` com `attachment` (arquivo). Resposta `200`: `{success, data:{messageId (wamid), conversationId, attachments[]}}` [doc]. Cabeçalho `Idempotency-Key` (24 h) [doc]. |
| Interativos | campo `interactive.type`: `list`, `cta_url`, `flow`, `location_request_message`, `request_contact_info`, `voice_call`, `product`, `product_list`, `catalog_message`, `carousel`, `address_message` | Só dentro da janela [doc]. Toques voltam em `message.received` com `metadata.interactiveType`, `interactiveId`, `flowResponseData`, `order`. |
| Enviar flow | `POST /v1/whatsapp/flows/send` + CRUD `/v1/whatsapp/flows` | [doc] |
| Reagir | `POST /v1/inbox/conversations/{cid}/messages/{messageId}/reactions` `{accountId, emoji}`; remover: `DELETE` mesmo caminho `?accountId=` | [doc] |
| Digitando | `POST /v1/inbox/conversations/{cid}/typing` `{accountId}` | [doc]. Sem estados `recording`/`paused`. |
| Marcar conversa como lida | `POST /v1/inbox/conversations/{cid}/read` `{accountId}` | `markedCount`. Tique azul **exceto em coexistência** [doc]. |
| Baixar mídia recebida | `GET /v1/whatsapp/media/{mediaId}?accountId=` | Autenticado, devolve binário. A URL do webhook já aponta para ele. **A Meta descarta mídia recebida após janela de retenção limitada; depois disso responde `400` para sempre**: baixar ao receber o webhook [doc]. |
| Subir mídia para enviar | `POST /v1/media/upload-direct` (multipart `file`, ~4,5 MB na prática) ou `POST /v1/media/presign` (arquivos grandes: `PUT` no `uploadUrl`, usar `publicUrl`) | Devolve URL pública [doc]. WhatsApp envia mídia por **link**: a URL tem de ser pública, sem autenticação, devolver o arquivo (não HTML) [doc]. |
| Bloquear/desbloquear | `POST/DELETE /v1/whatsapp/block-users` `{accountId, users[]<=1000}`; listar `GET /v1/whatsapp/block-users`; checar `GET /v1/whatsapp/block-users/status` | [doc] |
| Perfil comercial | `GET/POST /v1/whatsapp/business-profile` (`about<=139`, `description<=512`, `address`, `email`, `websites<=2`, `vertical`), foto em `/business-profile/photo`, nome em `/business-profile/display-name`, username em `/business-profile/username` | [doc]. Foto travada em coexistência. |
| Saúde do número | `GET /v1/whatsapp/number-info?accountId=` (`phone.status`, `quality_rating`, `messaging_limit_tier`, `throughput.level`, `platform_type`, `waba.business_verification_status`) e `GET /v1/accounts/{accountId}/health` | Se a Meta para de servir o objeto, devolve `400` (Graph erro 100, subcode 33): causa possível é desconexão pelo celular [doc]. |
| Contatos (CRM do Zernio) | `GET/POST /v1/contacts`, `GET/PATCH/DELETE /v1/contacts/{id}`, `POST /v1/contacts/bulk`, campos personalizados, tags | É o CRM do Zernio, **não** a agenda do WhatsApp. Em coexistência a agenda do app é importada para ele [doc]. |
| Broadcasts | `POST /v1/broadcasts`, `/send`, `/schedule`, `/cancel`, `/recipients` | Template em massa com variáveis por destinatário; único jeito de agendar [doc]. |
| Grupos | `/v1/whatsapp/wa-groups` (create, list, get, update, participants, invite-link, join-requests) | **Não em coexistência**; exige número só-Cloud-API com status OBA [doc]. |
| Ligações | `/v1/whatsapp/calling`, `/v1/whatsapp/calls` | **Não em coexistência** [doc]. |
| Editar/apagar mensagem | `PATCH`/`DELETE .../messages/{messageId}` | Doc do endpoint: WhatsApp **não suportado (400)**. [doc-conflito]: a página de eventos diz que `message.deleted` dispara quando o negócio apaga via DELETE. Tratar como não suportado até teste real. |

Formato do destinatário: `participantId` = telefone em dígitos com DDI, sem `+` (ex.: `15550100001`). `sender.phoneNumber` nos webhooks vem E.164 com `+`; `sender.id` vem sem `+` ou é o BSUID [doc].

## Webhooks

### Configuração (v2, config do provedor)

`POST /v1/webhooks/settings` `{name (1-50), url, secret, events[]}`; `GET/PUT/DELETE` no mesmo caminho; `POST /v1/webhooks/test`; logs em `GET /v1/webhooks/logs`; reentrega em `POST /v1/webhooks/logs/redeliver`. Até 50 endpoints por equipe. **O endpoint é por equipe, não por número**: um único endpoint recebe eventos de todos os números e filtra por `account.id`/`account.accountId`, `account.profileId` ou `profiles[].externalId` [doc]. O Zernio nunca gera o secret; quem cria define [doc].

### Entrega, assinatura e retries [doc]

- `POST` JSON, `Content-Type: application/json`, `User-Agent: Zernio-Webhooks/1.0`.
- Cabeçalhos: `X-Zernio-Event` (nome do evento), `X-Zernio-Event-Id` (= `payload.id`, chave de dedupe, igual em todo retry), `X-Zernio-Signature` (HMAC-SHA256 em hex minúsculo do **corpo bruto** com o secret). Cabeçalhos legados `X-Late-Signature` e `X-Late-Event-Id` ainda existem.
- Responder `2xx` em até **5 segundos**. Persistir e processar depois.
- Retries: até 7 tentativas em ~51 h (imediato, 10 s, 1m40s, 16m40s, 2h46m, 24 h, 24 h), depois dead-letter. Reentrega em `408`, `429`, `5xx`, timeout, erro de conexão e `2xx` com corpo HTML. Qualquer outro `4xx` encerra e vai para dead-letter na primeira tentativa. Duplicatas são possíveis. Com `429`/`503` + `Retry-After` o primeiro retry espera esse tempo (mín. 5 s, máx. 15 min) e novas entregas para a mesma URL são pausadas.
- Verificação: calcular HMAC do `rawBody` e comparar em tempo constante; `400` na falha (a doc usa 400; **um 4xx mata o evento**, então só devolver 4xx se a assinatura é de fato inválida). O `WebhookInput.rawBody` do waconector existe para isto.
- Evento de teste: `webhook.test` (`{id, event:"webhook.test", message, timestamp}`); eventos de amostra via `POST /v1/webhooks/test` trazem `test: true`.
- Todo payload tem `id` (dedupe) e `timestamp` (UTC de geração do evento, mantido em retries).

### Eventos de uso relevantes para o gateway [doc]

- `message.received`: `{id, event, message{id, conversationId, platform:"whatsapp", platformMessageId (wamid), direction:"incoming", text, attachments[{type,url,mimeType,payload.voice}], sender{id, contactId, name, phoneNumber, businessScopedUserId, whatsappUsername}, sentAt, isRead}, conversation{id, platformConversationId, participantId, participantName, status, contactId}, account{id, accountId, profileId, platform, username, displayName}, metadata, profiles[], timestamp}`. `metadata` carrega toques interativos, pedido (`order`), produto citado (`referredProduct`), citação (`quotedMessageId`), `standby`, `unsupported` (mídia não baixada, texto `[Unsupported message]`, código 131052).
- `message.sent`: mesmo envelope; **`sender` é o próprio negócio** (não o cliente: usar `conversation.participantId`); `source` (`cloud_api`, `whatsapp_business_app`, `meta_business_agent`), `sentVia`, ids de atribuição (`automationId`, `workflowId`, `executionId`, `broadcastId`, `sequenceId`), `pricing`, `billingConversation`, `metadata.location`/`metadata.contacts`. Disparado também para envios feitos pela API (no status).
- `message.delivered`, `message.read`, `message.played`, `message.failed`: `{id, event, message, statusAt, error{code,title,message} (só em failed), pricing, billingConversation, conversation, account, timestamp}`.
- `message.edited` (`editHistory`, `editCount`, `editedAt`), `message.deleted` (`deletedAt`, mantém texto original; WhatsApp reporta os dois sentidos, `message.direction` diferencia).
- `reaction.received`: `{reaction{emoji, action: added|removed, messageId, platformMessageId, sender, reactedAt}}`. **Na remoção `emoji` vem vazio** (a Cloud API não diz qual era). Quando o negócio reage pelo app ou API, `sender` é o id do negócio: comparar com `conversation.participantId`.
- `conversation.started`: uma vez por conversa, nos dois sentidos. `conversation.control_changed`: Meta Business Agent ou outro app assumiu/devolveu.
- Eventos de conta/saúde (úteis ao status da instância): `account.disconnected`, `account.connected`, `account.permissions_changed`, `account.restricted`, `account.recovered`, `whatsapp.account.status_updated`, `whatsapp.account.quality_updated`, `whatsapp.account.alert_received`, `whatsapp.template.status_updated`, `whatsapp.template.category_updated`, `whatsapp.contact.identity_changed` (usuário trocou de número/BSUID), `whatsapp.automatic_event`, `call.*` (não em coexistência).
- Payloads de amostra (sintéticos, do schema): `docs/providers/zernio/fixtures/`.

### Dados e mídia nos webhooks

- Mídia **recebida**: `attachments[].url` aponta para `GET /v1/whatsapp/media/{mediaId}` (autenticado; sem `Authorization` dá `401`). Baixar na hora [doc].
- Mídia **enviada**: `url` é a URL pública que o remetente passou (WhatsApp envia por link) [doc].
- Webhooks não trazem `refreshUrl` (só a leitura por REST) [doc].
- "Zero content retention" (configuração de equipe/perfil): o Zernio guarda só identificadores; conteúdo de mensagens, comentários e logs de webhook não é retido, e leituras REST devolvem campos de conteúdo `null` com `contentNotRetained: true` [doc]. **O gateway não pode depender de reler mensagens no Zernio**: se esse modo estiver ligado, o único registro do conteúdo é o do webhook recebido.

## Limites, erros e dados

- **Taxa da API**: 60 req/min (0-2 contas), 600 (3-2.000), 1.200 (2.001+), por workspace, janela deslizante; cabeçalhos `X-RateLimit-Limit/Remaining/Reset` e `Retry-After` no `429` [doc].
- **Vazão do número**: 20 msg/s em coexistência [doc]; 80 msg/s padrão em Cloud API só [inferência, Meta].
- **Por destinatário**: ~10 mensagens por minuto; excesso volta `400` código `131056` [doc].
- **Camadas (tier) da Meta**: número novo começa em 250 contatos únicos por dia, sobe com uso e qualidade [doc].
- **Mídia enviada**: imagem JPEG/PNG 5 MB; vídeo MP4/3GPP 16 MB (H.264+AAC); documento PDF/DOC(X)/XLS(X)/PPT(X)/TXT 100 MB; áudio MP3/OGG-Opus/AMR/AAC 16 MB; nota de voz exige OGG Opus mono + `voiceNote: true`. Multipart direto: até 25 MB declarado; `upload-direct` ~4,5 MB; presign até 5 GB [doc].
- **Retenção**: histórico da conversa fica no Zernio (a menos que zero retention); mídia recebida na Meta expira. Deleção de conversa no Zernio é só local [doc].
- **Idempotência**: `Idempotency-Key` (≤255) retido 24 h; mesma chave+mesmo corpo repete a resposta (`Idempotent-Replayed: true`); mesma chave+corpo diferente `422`; em voo `409`. Envio com erro `5xx` da Meta (ex. 131000) fica gravado e é replicado como `502`, porque a mensagem pode ter saído. **O Zernio não repete envios sozinho** [doc].
- **Envelope de erro**: `{error, type, code, param, details, platform, platformError{code,subcode,fbtraceId,type}, retryable?}`; ramificar por `type`/`code`, nunca pelo texto. Tipos: `invalid_request_error`, `authentication_error` (401), `permission_error` (403/402), `not_found`, `rate_limit_error` (429), `platform_error` (502 ou 4xx da plataforma), `api_error` (500/503). Códigos de envio WhatsApp: `PLATFORM_LIMITATION`, `TEMPLATE_REQUIRED`, `DIRECT_SEND_*`, `platform_api_error` [doc].
- **Códigos Meta no `platformError`/`error.code`**: `131047` janela fechada, `132001` template inexistente, `131026` não entregável, `131056` excesso por destinatário, `131052` falha ao baixar mídia, `131030` fora da lista de teste, `131031` conta restrita, `131021` destinatário = remetente, `133005` PIN de duas etapas [doc].
- **Sandbox** (para teste sem número próprio): número compartilhado do Zernio (`GET /v1/phone-numbers` → `sandbox`), 1 telefone de teste por usuário, sessão por resposta de ativação (`POST /v1/whatsapp/sandbox/sessions`), 1 template travado `sandbox_start`, texto/interativo livres dentro da janela, 50 mensagens/dia, ativa por 7 dias, grátis. **Não é coexistência**: serve para testar envio, resposta e webhooks, mas não o comportamento de eco/histórico [doc].
- **Preços**: workspace precisa de forma de pagamento para escritas (`402 workspace_billing_required`); número dedicado a partir de US$3/mês; número próprio sem taxa de número [doc].

## Mapa capability a capability (contrato waconector → Zernio)

Legenda: **Sim** = suportado no Zernio e pode ser declarado pelo adapter; **Parcial** = com restrição descrita; **Não** = o Zernio não oferece (o gateway devolve `UNSUPPORTED_CAPABILITY`). "Coex" = número em coexistência (o alvo deste adapter).

`instance.*`
- `instance.connect`: **Não** no sentido do contrato (não há QR nem pareamento via API; é um redirect OAuth/Embedded Signup que exige o celular na mão). Equivalente fica na v2 (`GET /v1/connect/whatsapp`, devolve `authUrl`).
- `instance.pairingCode`: **Não**.
- `instance.status`: **Sim**. `GET /v1/whatsapp/number-info` (`phone.status` `CONNECTED` → `connected`; erro `400` Graph 100/33 ou `account.disconnected` → `disconnected`; resto `unknown`) e/ou `GET /v1/accounts/{id}/health` [inferência no mapeamento de estados].
- `instance.logout`: **Não** (desconectar conta é configuração/v2; sair da coexistência só no celular).

`messages.*`
- `messages.sendText`: **Sim**. Exige `conversationId`; para telefone sem conversa só via template/Direct Send. `quotedId` → `replyTo` (wamid). `mentions`: não se aplica (1:1).
- `messages.sendMedia`: **Sim**. URL pública → `attachmentUrl`+`attachmentType` (`document` vira `file`, `sticker` não tem tipo próprio: **Não** para sticker) + `attachmentName`; legenda → `message`; base64 → subir via `upload-direct`/`presign` e usar a URL (ou multipart). Nota de voz via `voiceNote`.
- `messages.sendReaction`: **Sim**. Emoji vazio → `DELETE` da reação.
- `messages.edit`: **Não** (400 para WhatsApp).
- `messages.delete`: **Não** (400 na doc do endpoint) [doc-conflito com a doc de eventos].
- `messages.forward`: **Não**.
- `messages.star`, `messages.unstar`, `messages.pin`, `messages.unpin`: **Não**.
- `messages.markRead`: **Não** por mensagem (o Zernio só marca a conversa inteira; em coexistência nem manda tique azul).
- `messages.sendLocation`: **Sim** (`location`).
- `messages.sendContactCard`: **Sim** (`contacts[]`).
- `messages.sendPoll`: **Não** (a Cloud API não tem enquete).
- `messages.download`: **Sim** (`GET /v1/whatsapp/media/{mediaId}`; resolver `WaMessage.media.id` = `mediaId`; baixar ao receber).

`groups.*` (14 capabilities): **Não em coexistência** (a Groups API da Meta é desligada). Em número só-Cloud-API com OBA existem `create`, `getInfo`, `list`, `addParticipants`, `removeParticipants`, `updateSubject`, `updateDescription` (`POST /wa-groups/{id}` com `subject`/`description`), `getInviteLink` (invite-link); `updatePicture`, `promote/demote`, `revokeInviteLink`, `joinViaInviteLink` e `leaveGroup` não aparecem como endpoints dedicados [inferência pela lista de rotas]. Fora do escopo do adapter de coexistência.

`contacts.*`
- `contacts.list`, `contacts.get`: **Parcial**. Mapeiam o CRM do Zernio (`/v1/contacts`), não a agenda do WhatsApp; em coexistência a agenda do app é importada para lá [doc + inferência].
- `contacts.checkExists`: **Não** (a Cloud API não tem consulta "tem WhatsApp"; descobrir só tentando enviar: `131026`).
- `contacts.getProfilePicture`: **Parcial** (`participantPicture` na conversa, quando existir) [inferência].
- `contacts.getAbout`: **Não**.
- `contacts.block`, `contacts.unblock`, `contacts.listBlocked`: **Sim** (`/v1/whatsapp/block-users`; aceita telefone E.164 ou id WhatsApp).

`chats.*`
- `chats.archive`, `chats.unarchive`: **Sim** (`PUT /conversations/{id}` `status`). É estado **do Zernio**, não do app do celular [inferência].
- `chats.mute`, `chats.unmute`, `chats.pin`, `chats.unpin`: **Não**.
- `chats.markRead`: **Sim** (conversa inteira; sem tique azul em coexistência).
- `chats.markUnread`: **Não**.

`presence.*`
- `presence.setTyping`: **Parcial** (só indicador "digitando"; `recording`/`paused` não existem).
- `presence.set`, `presence.subscribe`: **Não**.

`labels.*` (6): **Não** para WhatsApp (rótulos de conversa existem só para Facebook Messenger). Tags de contato existem no CRM do Zernio (`contact.tag_added`), mas não equivalem ao contrato [doc + inferência].

`channels.*` (9): **Não**.

`business.*`
- `business.getProfile`, `business.updateProfile`: **Sim** (`/v1/whatsapp/business-profile`; foto travada em coexistência).

`calls.*`
- `calls.make`: **Não** (a chamada "vazia" do contrato não existe; Calling API real não funciona em coexistência).
- `calls.reject`: **Não** (sem endpoint de rejeição; calling indisponível em coexistência).

`webhooks.parse`: **Sim** (HMAC `X-Zernio-Signature` + dedupe por `X-Zernio-Event-Id`).

Resumo: o adapter Zernio em coexistência declara cerca de 17 das 72 capabilities (status, sendText, sendMedia, sendReaction, sendLocation, sendContactCard, download, contacts.get/list/block/unblock/listBlocked, chats.archive/unarchive/markRead, presence.setTyping, business.getProfile/updateProfile, webhooks.parse). O que o contrato do waconector não cobre e o Zernio tem (templates, interativos, Flows, broadcasts, janela de 24 h, catálogos) vira camada **nativa**.

## Pontos em que o contrato comum do waconector não encaixa

1. **Endereçamento**: o contrato usa `to`/`chatId` (telefone ou JID); o Zernio usa `conversationId`. O gateway precisa de uma tabela `chatId → conversationId` por instância (preenchida por webhook e por `search`/`list`).
2. **Janela de 24 h e templates** não existem no contrato. `sendText` para quem está fora da janela falha com `131047`; o gateway precisa de um erro canônico (`WINDOW_CLOSED`) e de um caminho comum para template (capability nova, ver issues) ou deixar na camada nativa.
3. **`fromMe`**: no `message.sent`, o `sender` é o negócio; o `chatId` vem de `conversation.participantId`.
4. **Ack**: o contrato tem `pending|sent|delivered|read|played|error`; o Zernio entrega `sent` (via `message.sent` do próprio envio), `delivered`, `read`, `played`, `failed` (com `error.code`). Mapeamento direto.
5. **Reação removida**: `reaction.emoji` vazio, igual ao `ReactionInfo` do contrato (string vazia = remoção). Encaixa.
6. **JIDs**: não existem. O identificador do contato é telefone ou BSUID; `@g.us`/`@s.whatsapp.net` não se aplicam.
7. **Mídia recebida** exige baixar com credencial e com prazo; `WaMessage.media.id` = `mediaId`, `messages.download` resolve.

## Riscos específicos da coexistência

1. Histórico reenviado repetidamente e eco de mensagens do celular: risco de **resposta automática a mensagem antiga ou a eco**. Filtrar por `source`, `direction`, `sentAt` e dedupe.
2. Estado de leitura é do celular: o agente não consegue "dar tique azul".
3. 20 msg/s fixos, sem grupos, sem ligações.
4. Desconexão silenciosa pelo celular (notificação best effort): precisa de verificação ativa periódica (`number-info`).
5. Meta Business Agent / `standby`: enviar mensagem pode tirar o controle; respeitar `metadata.standby`.
6. O telefone do celular precisa abrir o app periodicamente para manter a coexistência ativa (regra da Meta; a doc do Zernio não detalha) [inferência, confirmar com a Meta].
7. Identidade por BSUID: contatos sem telefone quebram qualquer lógica que assume E.164.
8. Zero retention (se ativado) tira o histórico do Zernio.
9. Lock-in e custo: Zernio mede mensagens e a Meta cobra templates na WABA do cliente.

## Camada nativa (v1, endpoints de USO)

Sob `/v1/instances/{id}/native/...`, repasse no formato do Zernio com `accountId` injetado e a API key escondida:

- Conversas: `GET conversations`, `GET conversations/search`, `GET conversations/{cid}`, `PUT conversations/{cid}` (arquivar), `POST conversations` (abrir com template/Direct Send), `POST conversations/{cid}/read`, `POST conversations/{cid}/typing`.
- Mensagens: `GET conversations/{cid}/messages`, `POST conversations/{cid}/messages` (todos os campos: template, interactive, buttons, location, contacts, category utility, multipart), `POST .../messages/{mid}/reactions`, `DELETE .../reactions`, `GET .../messages/{mid}/attachments/{index}`.
- Mídia: `GET whatsapp/media/{mediaId}`, `POST media/upload-direct`, `POST media/presign`.
- Templates (uso: listar/consultar para saber o que enviar): `GET whatsapp/templates`, `GET whatsapp/templates/{name}`, `GET whatsapp/template-library`.
- Flows (uso): `POST whatsapp/flows/send`, `GET whatsapp/flow-responses`.
- Broadcasts (uso): `POST broadcasts`, `POST broadcasts/{id}/send|schedule|cancel`, `GET broadcasts`, `GET broadcasts/{id}`, `GET/POST broadcasts/{id}/recipients`.
- Contatos CRM: `GET/POST contacts`, `GET/PATCH/DELETE contacts/{id}`, `POST contacts/bulk`, `GET contacts/{id}/channels`, campos personalizados.
- Bloqueio: `GET/POST/DELETE whatsapp/block-users`, `GET whatsapp/block-users/status`.
- Saúde e custos: `GET whatsapp/number-info`, `GET accounts/{accountId}/health`, `GET whatsapp/pricing-analytics`, `GET whatsapp/account-events`, `GET analytics/inbox/*`.
- Catálogo/comércio (uso): `GET whatsapp/catalogs`, `GET whatsapp/commerce-settings` (leitura).
- CTWA: `GET/POST whatsapp/conversions` (enviar conversão), `GET whatsapp/dataset`.

## Camada de configuração (v2, só mapeada em issues)

- Conexão e ciclo de vida da conta: `GET /v1/connect/whatsapp`, `/connect/whatsapp/credentials`, `/connect/whatsapp/select-phone-number`, `/connect/whatsapp/embedded-signup`, `/connect/whatsapp/sdk-config`, `DELETE /v1/accounts/{id}`, `/accounts/{id}/whatsapp/register|request-code|verify-code`.
- Webhooks do Zernio: `/v1/webhooks/settings` (CRUD), `/webhooks/test`, `/webhooks/logs`, `/webhooks/logs/redeliver`.
- Perfis e chaves: `/v1/profiles`, `/v1/api-keys`, `/v1/content-retention`.
- Templates: criar, editar, apagar (`POST/PATCH/DELETE /v1/whatsapp/templates...`).
- Perfil comercial e nome de exibição: `POST /v1/whatsapp/business-profile`, `/business-profile/photo`, `/display-name`, `/username`.
- Automação conversacional: `GET/POST/DELETE /v1/whatsapp/conversational-automation` (ice breakers e comandos).
- Flows (CRUD, publicar, deprecar, chave de criptografia), catálogos e comércio (`/whatsapp/catalogs`, `/whatsapp/commerce-settings`), Meta Business Agent, números (`/v1/phone-numbers`, KYC, port-in), sandbox (`/v1/whatsapp/sandbox/sessions`), grupos (`/v1/whatsapp/wa-groups`, só sem coexistência), ligações (`/v1/whatsapp/calling`).

## Não suportado pelo Zernio em relação ao contrato do waconector (resumo)

Pareamento por QR/código; logout por API; editar, apagar, encaminhar, favoritar e fixar mensagem; marcar mensagem individual como lida; enquetes; checar se um número tem WhatsApp; recado ("about") do contato; silenciar, fixar e marcar como não lida uma conversa; presença global e inscrição de presença; rótulos; canais; ligações (fazer e rejeitar); todos os recursos de grupo em coexistência; stickers como tipo de mídia de envio; menções (`mentions`).

