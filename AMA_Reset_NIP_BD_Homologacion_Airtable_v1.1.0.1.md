# AMA Reset NIP - BD Homologacion Airtable v1.1.0.1

## Objetivo y alcance
Este documento cierra la homologacion de campos entre `ama-reset-nip-api` y Airtable para el flujo de restablecimiento de NIP por vehiculo.

Incluye:
- Campos de entrada/salida del API.
- Campos de lectura en Airtable.
- Campos que no existen en Airtable y recomendacion de modelo.

No incluye:
- Escritura directa a Airtable desde backend en `confirm`.
- Migraciones de Airtable ejecutadas por este servicio.

## Fuentes de verdad usadas
- `index.js` desplegado (`v1.1.0.1`).
- `.env.example` del servicio.
- Esquema interno Postgres (`nip_reset_tokens`).
- Workflows n8n de smoke y persistencia.

## Matriz de homologacion (Airtable vs servicio)
| Pertenece a tabla | Nombre Airtable | Nombre nosotros |
|---|---|---|
| `Contactos` | `email` | `email` |
| `Contactos` | `whatsapp_id` | `whatsapp_id` |
| `Contactos` | `cliente_id` | `cliente_id` |
| `Vehiculos` | `whatsappNumero` | `AIRTABLE_VEHICULOS_CONTACTO_LINK_FIELD` (lookup por contacto/telefono) |
| `Vehiculos` | `vehiculoId` | `vehiculoId` |
| `Vehiculos` | `apodo` | `identifica_tu_vehiculo` (salida de negocio) |
| `Vehiculos` (opcional) | `cliente_id` | `AIRTABLE_VEHICULOS_CLIENTE_ID_FIELD` (fallback) |
| `Vehiculos` (opcional) | `whatsapp_id` u otro | `AIRTABLE_VEHICULOS_WHATSAPP_FIELD` (fallback) |

## Campos de contrato API que no son campos directos Airtable
| Campo servicio | Uso | Requiere campo nuevo en Airtable |
|---|---|---|
| `contacto_record_id` | ID tecnico de record Contactos | No (es record id Airtable) |
| `vehiculo_record_id` | ID tecnico de record Vehiculos | No (es record id Airtable) |
| `step` | control de UI (`confirmar_vehiculo_unico`/`seleccionar_vehiculo`) | No |
| `identifica_tu_vehiculo` | etiqueta UX para frontend | No (derivado de `apodo`) |
| `request_id` | trazabilidad webhook | Recomendado en tabla eventos |
| `evento` (`NIP_RESET_CONFIRMADO`) | tipo de evento webhook | Recomendado en tabla eventos |
| `timestamp` | auditoria webhook | Recomendado en tabla eventos |
| `nuevo_nip` | dato operativo de cambio NIP | No recomendado en tablas de negocio (dato sensible) |

## Propuesta cerrada de modelo Airtable
### Opcion A (minima)
- Mantener tablas actuales `Contactos` y `Vehiculos` sin cambios estructurales.
- Persistencia del nuevo NIP queda en subworkflow/agente (fuera de este backend).

### Opcion B (recomendada)
Crear tabla nueva: `NIP_Reset_Eventos`.

Justificacion tecnica:
1. Trazabilidad por evento (`request_id`, `timestamp`, estado).
2. Auditoria e idempotencia sin sobrecargar `Contactos`/`Vehiculos`.
3. Desacoplamiento: backend emite webhook, agente persiste.
4. Escalabilidad para reintentos y observabilidad operativa.

## Esquema sugerido: `NIP_Reset_Eventos`
| Campo sugerido | Tipo Airtable | Obligatorio | Fuente | Justificacion |
|---|---|---|---|---|
| `request_id` | Single line text | Si | webhook `confirm` | Idempotencia y correlacion |
| `evento` | Single select | Si | webhook `confirm` | Clasificacion de evento |
| `timestamp` | Date-time | Si | webhook `confirm` | Auditoria temporal |
| `cliente_id` | Single line text | Si | token/contexto | Relacion de negocio |
| `vehiculoId` | Single line text | Si | token/contexto | Relacion por vehiculo |
| `contacto_record_id` | Single line text | No | lookup | Traza tecnica |
| `vehiculo_record_id` | Single line text | No | lookup | Traza tecnica |
| `apodo` | Single line text | No | vehiculo | Contexto humano |
| `estado_persistencia` | Single select | Si | agente/subworkflow | Control operacional |
| `observaciones` | Long text | No | agente/subworkflow | Diagnostico |

Nota de seguridad: evitar almacenar `nuevo_nip` en texto plano en Airtable.

## Postgres interno (control)
Tabla `nip_reset_tokens` ya extendida con:
- `cliente_id`
- `contacto_record_id`
- `vehiculo_id`
- `vehiculo_record_id`
- `vehiculo_apodo`

Indice activo:
- `idx_nip_reset_tokens_cliente_vehiculo_created_at`.
- `ux_nip_reset_tokens_cliente_vehiculo_activo` (token activo unico por cliente+vehiculo).

## Checklist para admin Airtable
1. Verificar `Contactos`: `email`, `whatsapp_id`, `cliente_id`.
2. Verificar `Vehiculos`: `vehiculoId`, `apodo`, `whatsappNumero`.
3. Confirmar tipo de `whatsappNumero` (link o texto) y consistencia de datos.
4. Crear `NIP_Reset_Eventos` (recomendado).
5. Configurar subworkflow/agente para persistir estado de evento.
