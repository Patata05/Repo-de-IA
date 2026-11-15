-- Memoria de agente (PydanticAI): ModelRequest / ModelResponse en JSONB.
-- session_id = id del chat del front (localStorage).

create table if not exists public.chat_agent_memory (
  session_id text primary key,
  messages_json jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

create index if not exists chat_agent_memory_updated_at_idx
  on public.chat_agent_memory (updated_at desc);

alter table public.chat_agent_memory enable row level security;

-- Sin políticas para anon/authenticated: solo service_role (backend) escribe/lee.
-- RLS bypass con SUPABASE_SERVICE_ROLE_KEY.
drop policy if exists chat_agent_memory_service_all on public.chat_agent_memory;

comment on table public.chat_agent_memory is
  'Historial PydanticAI (messages_json) por sesión de chat.';
