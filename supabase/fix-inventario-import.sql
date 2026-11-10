-- Arregla importación CSV/Excel:
-- 1) Crea public.inventario (minúsculas) con las columnas que usa la app
-- 2) Permite lectura/escritura con la anon key
-- 3) Recarga el schema cache de PostgREST
--
-- Cómo usarlo: Supabase → SQL Editor → pegar y Run

CREATE TABLE IF NOT EXISTS public.inventario (
    id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    etiqueta       VARCHAR(255) NOT NULL,
    articulo       VARCHAR(500) NOT NULL,
    marca          VARCHAR(255),
    modelo         VARCHAR(255),
    serie          VARCHAR(255),
    area           VARCHAR(255) NOT NULL,
    persona        VARCHAR(255),
    cantidad       INTEGER      NOT NULL DEFAULT 1 CHECK (cantidad >= 0),
    observaciones  TEXT,
    estado         VARCHAR(20)  NOT NULL DEFAULT 'Activo',
    origen         VARCHAR(60)  NOT NULL DEFAULT 'S/O',
    created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ  NOT NULL DEFAULT now()
);

ALTER TABLE public.inventario ADD COLUMN IF NOT EXISTS etiqueta VARCHAR(255);
ALTER TABLE public.inventario ADD COLUMN IF NOT EXISTS articulo VARCHAR(500);
ALTER TABLE public.inventario ADD COLUMN IF NOT EXISTS marca VARCHAR(255);
ALTER TABLE public.inventario ADD COLUMN IF NOT EXISTS modelo VARCHAR(255);
ALTER TABLE public.inventario ADD COLUMN IF NOT EXISTS serie VARCHAR(255);
ALTER TABLE public.inventario ADD COLUMN IF NOT EXISTS area VARCHAR(255);
ALTER TABLE public.inventario ADD COLUMN IF NOT EXISTS persona VARCHAR(255);
ALTER TABLE public.inventario ADD COLUMN IF NOT EXISTS cantidad INTEGER;
ALTER TABLE public.inventario ADD COLUMN IF NOT EXISTS observaciones TEXT;
ALTER TABLE public.inventario ADD COLUMN IF NOT EXISTS estado VARCHAR(20);
ALTER TABLE public.inventario ADD COLUMN IF NOT EXISTS origen VARCHAR(60);
ALTER TABLE public.inventario ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;
ALTER TABLE public.inventario ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;

ALTER TABLE public.inventario ALTER COLUMN etiqueta TYPE VARCHAR(255);
ALTER TABLE public.inventario ALTER COLUMN articulo TYPE VARCHAR(500);
ALTER TABLE public.inventario ALTER COLUMN marca TYPE VARCHAR(255);
ALTER TABLE public.inventario ALTER COLUMN modelo TYPE VARCHAR(255);
ALTER TABLE public.inventario ALTER COLUMN serie TYPE VARCHAR(255);
ALTER TABLE public.inventario ALTER COLUMN area TYPE VARCHAR(255);
ALTER TABLE public.inventario ALTER COLUMN persona TYPE VARCHAR(255);

UPDATE public.inventario SET estado = 'Activo' WHERE estado IS NULL OR btrim(estado) = '';
ALTER TABLE public.inventario ALTER COLUMN estado SET DEFAULT 'Activo';

CREATE INDEX IF NOT EXISTS idx_inventario_area     ON public.inventario (area);
CREATE INDEX IF NOT EXISTS idx_inventario_persona  ON public.inventario (persona);
CREATE INDEX IF NOT EXISTS idx_inventario_articulo ON public.inventario (articulo);
CREATE UNIQUE INDEX IF NOT EXISTS inventario_etiqueta_origen_key
  ON public.inventario (etiqueta, origen);

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_inventario_updated_at ON public.inventario;
CREATE TRIGGER trg_inventario_updated_at
BEFORE UPDATE ON public.inventario
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.inventario ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Usuarios autenticados ven inventario" ON public.inventario;
DROP POLICY IF EXISTS "Usuarios autenticados insertan inventario" ON public.inventario;
DROP POLICY IF EXISTS "Usuarios autenticados actualizan inventario" ON public.inventario;
DROP POLICY IF EXISTS "Usuarios autenticados eliminan inventario" ON public.inventario;
DROP POLICY IF EXISTS "anon_select_inventario" ON public.inventario;
DROP POLICY IF EXISTS "anon_insert_inventario" ON public.inventario;
DROP POLICY IF EXISTS "anon_update_inventario" ON public.inventario;
DROP POLICY IF EXISTS "anon_delete_inventario" ON public.inventario;

CREATE POLICY "anon_select_inventario"
ON public.inventario FOR SELECT
TO anon, authenticated
USING (true);

CREATE POLICY "anon_insert_inventario"
ON public.inventario FOR INSERT
TO anon, authenticated
WITH CHECK (true);

CREATE POLICY "anon_update_inventario"
ON public.inventario FOR UPDATE
TO anon, authenticated
USING (true)
WITH CHECK (true);

CREATE POLICY "anon_delete_inventario"
ON public.inventario FOR DELETE
TO anon, authenticated
USING (true);

GRANT USAGE ON SCHEMA public TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.inventario TO anon, authenticated;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
