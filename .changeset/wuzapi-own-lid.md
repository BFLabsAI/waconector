---
'waconector': minor
---

Aditivo: capability `instance.getSelf` + `InstanceApi.getSelf()` (`InstanceSelf {jid, phone, lid, name, raw}`) e `ConnectionUpdateEvent.selfJid/selfLid`. wuzapi: `getSelf` usa `GET /session/status` + `GET /user/lid/{n}` (404 = sem lid); `PairSuccess` expõe `selfJid`/`selfLid` (antes descartava o `LID`).
