-- Few-shot dinámico: ejemplos aprobados / correcciones del usuario.
-- Corre en Supabase SQL Editor (requiere extensión vector).

create extension if not exists vector;

create table if not exists public.ai_learned_examples (
  id bigint generated always as identity primary key,
  pregunta_usuario text not null,
  intencion_y_filtros text not null default '',
  respuesta_ideal text not null,
  embedding vector(1536),
  source text not null default 'thumbs_up'
    check (source in ('thumbs_up', 'correction', 'manual')),
  session_id text,
  created_at timestamptz not null default now()
);

-- Por si la tabla ya existía sin alguna columna:
alter table public.ai_learned_examples
  add column if not exists embedding vector(1536);
alter table public.ai_learned_examples
  add column if not exists source text not null default 'thumbs_up';
alter table public.ai_learned_examples
  add column if not exists session_id text;
alter table public.ai_learned_examples
  add column if not exists created_at timestamptz not null default now();
alter table public.ai_learned_examples
  add column if not exists intencion_y_filtros text not null default '';

create index if not exists ai_learned_examples_created_at_idx
  on public.ai_learned_examples (created_at desc);

comment on table public.ai_learned_examples is
  'Ejemplos few-shot del chat (pulgar arriba / correcciones). Embedding 1536.';

alter table public.ai_learned_examples enable row level security;

-- Backend usa SUPABASE_SERVICE_ROLE_KEY (bypassa RLS). Grants explícitos:
grant usage on schema public to service_role;
grant all on table public.ai_learned_examples to service_role;
grant usage, select on all sequences in schema public to service_role;

-- Por si alguien usa anon con políticas (opcional; service_role basta):
drop policy if exists ai_learned_examples_service_insert on public.ai_learned_examples;
-- Sin políticas para anon/authenticated: solo service_role escribe/lee.

create or replace function public.match_ai_learned_examples(
  query_embedding vector(1536),
  match_count int default 2,
  match_threshold float default 0.80
)
returns table (
  id bigint,
  pregunta_usuario text,
  intencion_y_filtros text,
  respuesta_ideal text,
  source text,
  similarity float
)
language sql
stable
security definer
set search_path = public
as $$
  select
    e.id,
    e.pregunta_usuario,
    e.intencion_y_filtros,
    e.respuesta_ideal,
    e.source,
    (1 - (e.embedding <=> query_embedding))::float as similarity
  from public.ai_learned_examples e
  where e.embedding is not null
    and 1 - (e.embedding <=> query_embedding) >= match_threshold
  order by e.embedding <=> query_embedding
  limit greatest(1, least(coalesce(match_count, 2), 5));
$$;

grant execute on function public.match_ai_learned_examples(vector, int, float)
  to anon, authenticated, service_role;
