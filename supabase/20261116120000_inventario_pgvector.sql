-- Fase posterior (pgvector): búsqueda semántica de artículos.
-- Activar en Supabase SQL Editor cuando se implemente embeddings + tool buscar_semantico.

create extension if not exists vector;

alter table if exists public.inventario
  add column if not exists embedding vector(1536);

comment on column public.inventario.embedding is
  'Embedding de articulo|marca|modelo|area|persona para buscar_semantico';

-- Índice cuando haya filas con embedding:
-- create index if not exists inventario_embedding_ivfflat
--   on public.inventario using ivfflat (embedding vector_cosine_ops)
--   with (lists = 100);
