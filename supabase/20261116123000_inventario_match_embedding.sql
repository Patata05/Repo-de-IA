-- RPC de búsqueda semántica (pgvector).
-- La columna embedding vector(1536) ya debe existir (SQL anterior).
-- Corre esto en Supabase SQL Editor.

create or replace function public.match_inventario(
  query_embedding vector(1536),
  match_count int default 15,
  match_threshold float default 0.25
)
returns table (
  id bigint,
  etiqueta text,
  articulo text,
  marca text,
  modelo text,
  serie text,
  area text,
  persona text,
  cantidad numeric,
  estado text,
  origen text,
  observaciones text,
  created_at timestamptz,
  updated_at timestamptz,
  similarity float
)
language sql
stable
as $$
  select
    i.id::bigint,
    i.etiqueta::text,
    i.articulo::text,
    i.marca::text,
    i.modelo::text,
    i.serie::text,
    i.area::text,
    i.persona::text,
    i.cantidad::numeric,
    i.estado::text,
    i.origen::text,
    i.observaciones::text,
    i.created_at,
    i.updated_at,
    (1 - (i.embedding <=> query_embedding))::float as similarity
  from public.inventario i
  where i.embedding is not null
    and 1 - (i.embedding <=> query_embedding) >= match_threshold
  order by i.embedding <=> query_embedding
  limit greatest(1, least(coalesce(match_count, 15), 50));
$$;

grant execute on function public.match_inventario(vector, int, float) to anon, authenticated, service_role;

-- Después del backfill (cuando haya muchas filas con embedding):
-- create index if not exists inventario_embedding_ivfflat
--   on public.inventario using ivfflat (embedding vector_cosine_ops)
--   with (lists = 100);
