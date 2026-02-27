-- v1.1.0.0 - Extiende contexto de token por cliente + vehiculo
ALTER TABLE public.nip_reset_tokens
  ADD COLUMN IF NOT EXISTS cliente_id text,
  ADD COLUMN IF NOT EXISTS contacto_record_id text,
  ADD COLUMN IF NOT EXISTS vehiculo_id text,
  ADD COLUMN IF NOT EXISTS vehiculo_record_id text,
  ADD COLUMN IF NOT EXISTS vehiculo_apodo text;

CREATE INDEX IF NOT EXISTS idx_nip_reset_tokens_cliente_vehiculo_created_at
  ON public.nip_reset_tokens (cliente_id, vehiculo_id, created_at DESC);
