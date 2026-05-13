create extension if not exists pgcrypto;

create table if not exists conversation_messages (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  conversation_id text not null,
  customer_phone text,
  direction text not null check (direction in ('inbound', 'outbound')),
  role text not null check (role in ('user', 'assistant', 'system')),
  body text not null,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_conversation_messages_conversation_created
  on conversation_messages(conversation_id, created_at desc);

create table if not exists conversation_quality_issues (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references conversation_messages(id) on delete cascade,
  conversation_id text not null,
  quality_score numeric(5,4) not null,
  is_robotic boolean not null default false,
  is_repetitive boolean not null default false,
  lacks_empathy boolean not null default false,
  hallucination_risk boolean not null default false,
  user_complaint_signal boolean not null default false,
  reasons text[] not null default '{}',
  embedding jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_quality_issues_created_score
  on conversation_quality_issues(created_at desc, quality_score);

create table if not exists prompt_versions (
  id uuid primary key default gen_random_uuid(),
  version int not null unique,
  prompt_text text not null,
  status text not null check (status in ('active', 'candidate', 'archived', 'rejected', 'deployed')),
  quality_score numeric(6,4),
  source text,
  created_at timestamptz not null default now()
);

create index if not exists idx_prompt_versions_status_created
  on prompt_versions(status, created_at desc);

create table if not exists simulation_cases (
  id uuid primary key default gen_random_uuid(),
  input text not null unique,
  context text,
  expected text not null,
  tags text[] not null default '{}',
  created_at timestamptz not null default now()
);

create table if not exists improvement_runs (
  id uuid primary key default gen_random_uuid(),
  trigger_reason text not null,
  status text not null,
  baseline_prompt_id uuid references prompt_versions(id) on delete set null,
  candidate_prompt_id uuid references prompt_versions(id) on delete set null,
  baseline_score numeric(6,4),
  candidate_score numeric(6,4),
  deploy_id text,
  summary text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_improvement_runs_created
  on improvement_runs(created_at desc);
