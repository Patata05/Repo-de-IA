-- Auditoría de cambios del inventario (quién / qué / cuándo)
-- Idempotente: se puede ejecutar aunque la tabla ya exista.

CREATE TABLE IF NOT EXISTS public.inventario_auditoria (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    inventario_id   BIGINT,
    etiqueta        TEXT,
    accion          TEXT NOT NULL CHECK (accion IN ('create', 'update', 'delete')),
    campo           TEXT,
    valor_antes     TEXT,
    valor_despues   TEXT,
    origen          TEXT,
    actor           TEXT NOT NULL DEFAULT 'sistema',
    chat_id         TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_inventario_auditoria_inventario_id
  ON public.inventario_auditoria (inventario_id);
CREATE INDEX IF NOT EXISTS idx_inventario_auditoria_etiqueta
  ON public.inventario_auditoria (etiqueta);
CREATE INDEX IF NOT EXISTS idx_inventario_auditoria_created_at
  ON public.inventario_auditoria (created_at DESC);

ALTER TABLE public.inventario_auditoria ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon lee auditoria inventario" ON public.inventario_auditoria;
CREATE POLICY "anon lee auditoria inventario"
ON public.inventario_auditoria FOR SELECT
TO anon, authenticated
USING (true);

DROP POLICY IF EXISTS "anon inserta auditoria inventario" ON public.inventario_auditoria;
CREATE POLICY "anon inserta auditoria inventario"
ON public.inventario_auditoria FOR INSERT
TO anon, authenticated
WITH CHECK (true);
