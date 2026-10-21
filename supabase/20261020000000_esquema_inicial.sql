-- ==========================================
-- Esquema inicial: inventario de oficina
-- Idempotente: se puede ejecutar aunque la tabla ya exista
-- ==========================================

-- Tabla
CREATE TABLE IF NOT EXISTS public.inventario (
    id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    etiqueta       VARCHAR(50)  NOT NULL UNIQUE,
    articulo       VARCHAR(150) NOT NULL,
    marca          VARCHAR(100),
    modelo         VARCHAR(100),
    serie          VARCHAR(100) UNIQUE,
    area           VARCHAR(100) NOT NULL,
    persona        VARCHAR(150),
    cantidad       INTEGER      NOT NULL DEFAULT 1 CHECK (cantidad >= 0),
    observaciones  TEXT,
    origen         VARCHAR(20)  NOT NULL DEFAULT 'Compra'
                   CHECK (origen IN ('Compra', 'Donación', 'Préstamo', 'Traslado', 'Otro')),
    created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Índices
CREATE INDEX IF NOT EXISTS idx_inventario_area     ON public.inventario (area);
CREATE INDEX IF NOT EXISTS idx_inventario_persona  ON public.inventario (persona);
CREATE INDEX IF NOT EXISTS idx_inventario_articulo ON public.inventario (articulo);

-- Función y trigger para updated_at
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

-- Row Level Security
ALTER TABLE public.inventario ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Usuarios autenticados ven inventario" ON public.inventario;
CREATE POLICY "Usuarios autenticados ven inventario"
ON public.inventario FOR SELECT
TO authenticated
USING (true);

DROP POLICY IF EXISTS "Usuarios autenticados insertan inventario" ON public.inventario;
CREATE POLICY "Usuarios autenticados insertan inventario"
ON public.inventario FOR INSERT
TO authenticated
WITH CHECK (true);

DROP POLICY IF EXISTS "Usuarios autenticados actualizan inventario" ON public.inventario;
CREATE POLICY "Usuarios autenticados actualizan inventario"
ON public.inventario FOR UPDATE
TO authenticated
USING (true)
WITH CHECK (true);

DROP POLICY IF EXISTS "Usuarios autenticados eliminan inventario" ON public.inventario;
CREATE POLICY "Usuarios autenticados eliminan inventario"
ON public.inventario FOR DELETE
TO authenticated
USING (true);
