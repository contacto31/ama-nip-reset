# Prompt Hostinger Horizons - Reset NIP por Vehiculo (v1.1.0.1)

Usa este prompt completo en Hostinger Horizons para actualizar la pantalla existente en `https://amatracksafe.com.mx/siniestros`.

---

Quiero que modifiques la funcionalidad actual del modal "Restablecer NIP" (misma ruta y mismo boton actual), sin crear una ruta nueva.

## Objetivo
Implementar flujo por vehiculo contra API `https://reset.amatracksafe.com.mx`.

## Reglas de negocio
1. El usuario captura `email` y `telefono` (10 digitos).
2. Se llama `POST /nip-reset/lookup` con:
```json
{ "email": "...", "whatsapp_id": "..." }
```
3. Si responde `404` con `Datos incorrectos`, mostrar ese mensaje en el modal.
4. Si responde `200`:
- Si `step=confirmar_vehiculo_unico`, mostrar campo bloqueado `Identifica tu vehiculo` con el apodo.
- Si `step=seleccionar_vehiculo`, mostrar dropdown `Identifica tu vehiculo` con los apodos y pedir confirmacion.
5. Botones por estado:
- Inicial: `Continuar`.
- Vehiculo unico: `Solicitar reset` y `Cancelar`.
- Multiples: `Confirmar` y `Regresar`.
6. Si confirma vehiculo, llamar `POST /nip-reset/send-link` con:
```json
{
  "email": "...",
  "whatsapp_id": "...",
  "cliente_id": "...",
  "vehiculoId": "..."
}
```
7. Si `send-link` es `200`, mostrar:
`Hemos enviado al correo registrado la URL para reiniciar tu NIP.`
8. Si cancela, cerrar modal y volver al estado normal de `/siniestros`.

## Flujo con token (pantalla restablecer)
Si la pagina carga con `?token=...`:
1. Llamar `GET /nip-reset/token-info?token=...`.
2. Si `200`, mostrar:
- campo bloqueado `Identifica tu vehiculo`.
- `Nuevo NIP` y `Confirmar NIP`.
- boton `Cambiar NIP`.
3. Si `403`, mostrar `Liga invalida o expirada.` y opcion para volver a solicitar.
4. Al enviar, llamar `POST /nip-reset/confirm` con:
```json
{ "token": "...", "nip": "1234", "nipConfirm": "1234" }
```
5. Mostrar mensajes de backend segun status (`200`, `400`, `403`, `503`).

## Validaciones frontend obligatorias
- `email` valido.
- `telefono` numerico de 10 digitos.
- `nip` y `nipConfirm` de 4 digitos.
- bloquear doble submit (botones disabled durante request).
- no guardar token ni NIP en localStorage/sessionStorage.
- no imprimir token ni NIP en consola.

## UX/copy
- Mantener titulo del modal: `Restablecer NIP`.
- Campo: `Identifica tu vehiculo`.
- Mensajes:
  - `Datos incorrectos`
  - `Hemos enviado al correo registrado la URL para reiniciar tu NIP.`
  - `Liga invalida o expirada.`

## Integracion tecnica
- Base URL API: `https://reset.amatracksafe.com.mx`
- Enviar `Content-Type: application/json`.
- Manejar errores por `message` retornado por backend.
- Mantener estilos actuales del sitio, solo extender estados del modal.

## Criterios de aceptacion
1. Flujo lookup invalido muestra error correcto.
2. Flujo vehiculo unico permite solicitar reset.
3. Flujo multivehiculo permite seleccionar y confirmar uno.
4. Send-link exitoso muestra confirmacion de correo.
5. Token-info valido muestra vehiculo bloqueado y formulario NIP.
6. Confirm maneja 400/403/503/200 correctamente.
7. No se rompe la pagina `/siniestros` ni el resto de modales.

---

Al terminar, entregame:
1. Resumen de cambios aplicados.
2. Lista de componentes/archivos modificados.
3. Casos de prueba manual ejecutados y resultado.
