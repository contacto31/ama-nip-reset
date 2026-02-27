# AMA Reset NIP - Control de Versiones

## Objetivo
Llevar trazabilidad del servicio `ama-reset-nip-api` con convencion `A.B.C.D`, incluyendo cambios funcionales, ajustes tecnicos y evidencia de validacion.

## Convencion de version
- `A`: cambio mayor de producto/arquitectura.
- `B`: nueva funcionalidad compatible.
- `C`: ajuste funcional menor o mejora operativa.
- `D`: hotfix/correccion puntual.

## Historial
| Version | Nombre | Fecha | Estado | Cambios clave |
|---|---|---|---|---|
| `1.0.0.0` | Version inicial | 2026-02-26 | Cerrada | Servicio base de reset NIP con token por correo. |
| `1.1.0.0` | Flujo por vehiculo + persistencia por webhook | 2026-02-27 | Cerrada | Endpoints `lookup`, `send-link`, `token-info`, `confirm`; token por `cliente_id + vehiculoId`; confirmacion delegada a webhook firmado. |
| `1.1.0.1` | Fix compatibilidad Airtable formulas | 2026-02-27 | Vigente | Se elimino `TOSTRING(...)` en formulas Airtable y se reemplazo por coercion compatible `({campo}&'')`; se estabilizo `lookup_valid` en smoke. |

## Evidencia de cierre tecnico vigente (`1.1.0.1`)
- Corrida smoke (lookup positivo): `8/8 PASS`.
- Corrida smoke (send-link real): `8/8 PASS`.
- Resultado esperado validado:
  - `lookup_valid` -> `200` con `step=confirmar_vehiculo_unico`.
  - `send_link_valid` -> `200` con mensaje de envio de liga.

## Regla de versionado operativa
Cada cambio nuevo debe actualizar:
1. Numero de version (`A.B.C.D`).
2. Nombre corto del cambio.
3. Estado (`En validacion` o `Cerrada`).
4. Evidencia de pruebas.

## Plantilla de commit/release
```bash
git add .
git commit -m "feat(reset-nip): <descripcion> (vA.B.C.D)"
git push origin main
```

Si aplica tag:
```bash
git tag vA.B.C.D
git push origin vA.B.C.D
```
