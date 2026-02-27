# AMA Reset NIP - Documentacion Tecnica v1.1.0.1

## 1) Resumen del servicio
`ama-reset-nip-api` permite restablecer el NIP del cliente por flujo seguro con token temporal y validacion por vehiculo.

El backend:
- valida `email + whatsapp_id` contra Airtable,
- identifica vehiculos del cliente,
- envia liga por correo,
- valida token y confirma NIP,
- emite webhook firmado para persistencia final (subworkflow/agente).

## 2) Arquitectura y componentes
- API Node.js + Express.
- Postgres interno (`nip_reset_tokens`) para control de tokens.
- Airtable (solo lectura): `Contactos` y `Vehiculos`.
- SMTP (envio de correo de reset).
- n8n/subworkflow receptor para persistencia final de NIP.

## 3) Endpoints vigentes
### `POST /nip-reset/lookup`
Entrada:
```json
{ "email": "cliente@dominio.com", "whatsapp_id": "5512345678" }
```
Salidas:
- `404` -> `Datos incorrectos`.
- `200` -> `step=confirmar_vehiculo_unico` o `step=seleccionar_vehiculo`, con `vehiculos[]`.

### `POST /nip-reset/send-link`
Entrada:
```json
{
  "email": "cliente@dominio.com",
  "whatsapp_id": "5512345678",
  "cliente_id": "8",
  "vehiculoId": "VEH-SMOKE-001"
}
```
Salida:
- `200` -> `Hemos enviado al correo registrado la URL para reiniciar tu NIP.`

### `GET /nip-reset/token-info?token=...`
- `200` token valido con `cliente_id`, `vehiculoId`, `identifica_tu_vehiculo`.
- `403` token invalido/expirado/usado.

### `POST /nip-reset/confirm`
Entrada:
```json
{ "token": "...", "nip": "1234", "nipConfirm": "1234" }
```
Comportamiento:
- `400` si NIP no coincide.
- `403` si token invalido/expirado/usado.
- `503` si falla webhook de persistencia (token no se consume).
- `200` si webhook ok y token consumido.

## 4) Flujo funcional
1. Cliente captura correo y telefono.
2. `lookup` valida contacto y obtiene vehiculo(s).
3. Front confirma vehiculo objetivo.
4. `send-link` crea token por `cliente_id + vehiculoId` y envia correo.
5. Cliente abre liga y consulta `token-info`.
6. Cliente confirma nuevo NIP.
7. `confirm` envia webhook firmado `NIP_RESET_CONFIRMADO`.
8. Si webhook responde `2xx`, token se marca usado.

## 5) Seguridad
- Helmet activo.
- CORS estricto solo en `/nip-reset/*` con allowlist (`ALLOWED_ORIGINS`).
- Rate limits por endpoint (`lookup`, `send-link`, `confirm`).
- Token en DB almacenado como `sha256(token)`.
- Webhook firmado con HMAC SHA-256:
  - `x-ama-event`
  - `x-ama-timestamp`
  - `x-ama-signature`
- No persistencia directa en Airtable desde `confirm`.

## 6) Variables de entorno relevantes
- `DATABASE_URL`
- `ALLOWED_ORIGINS`
- `AIRTABLE_API_KEY`, `AIRTABLE_BASE_ID`
- `AIRTABLE_CONTACTOS_*`
- `AIRTABLE_VEHICULOS_*`
- `SMTP_*`, `MAIL_FROM`, `MAIL_LOGO_URL`
- `RESET_LINK_BASE`, `RESET_TOKEN_TTL_MINUTES`
- `NIP_*_RATE_*`
- `CUSTOMER_VEHICLE_RATE_*`
- `NIP_PERSIST_WEBHOOK_URL`
- `NIP_PERSIST_WEBHOOK_SECRET`
- `NIP_PERSIST_WEBHOOK_TIMEOUT_MS`
- `NIP_PERSIST_WEBHOOK_RETRY_DELAY_MS`

## 7) Operacion n8n (smoke)
Workflows:
- `AMA Reset NIP - Smoke Tests (Subworkflow)`
- `AMA Reset NIP - Smoke Runner`

Escenarios validados:
- Corrida 2 (lookup positivo): `8/8 PASS`.
- Corrida 3 (send-link positivo): `8/8 PASS`.

## 8) Troubleshooting rapido
### Error 422 con Airtable formula
Sintoma:
- `INVALID_FILTER_BY_FORMULA` por `TOSTRING`.

Correccion aplicada en `v1.1.0.1`:
- Reemplazo de `TOSTRING({campo})='x'` por `({campo}&'')='x'`.

### `lookup_valid` en 404
Revisar:
1. Contacto coincide por `email + whatsapp_id`.
2. `cliente_id` no vacio en Contactos.
3. Vehiculo vinculado visible por `whatsappNumero`.
4. `vehiculoId` y `apodo` con valor.

## 9) Limitaciones conocidas
- Airtable solo lectura en backend.
- Persistencia final depende de subworkflow/agente.
- Si SMTP o webhook fallan, el flujo de negocio no se completa.

## 10) Guia post-deploy
1. Deploy backend.
2. Confirmar env vars.
3. Publicar subworkflow y luego runner en n8n.
4. Ejecutar smoke:
   - `runPositiveLookup=true`
   - `runSendLink=true`
5. Verificar `summary.failed = 0`.
