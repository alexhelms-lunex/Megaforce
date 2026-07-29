-- 0003_config_defaults.sql
-- Configuration data, not demo data. These rows are expected to exist in
-- production. Re-running is a no-op.

-- ---------------------------------------------------------------------------
-- Qualification rules
--
-- The shipped default is the rule as specified: a call must run at least 120
-- seconds AND have connected. Both numbers live here rather than in code, so
-- changing "two minutes" to "one minute" is an admin action, not a deploy.
-- ---------------------------------------------------------------------------
insert into qualification_rules (activity_type, min_duration_seconds, allowed_results, required_direction, active)
values ('call', 120, array['Call connected','Accepted'], null, true)
on conflict (activity_type) where active do nothing;

-- An email that was actually sent or received counts. There is no duration to
-- threshold on, so the rule is permissive and says so.
insert into qualification_rules (activity_type, min_duration_seconds, allowed_results, required_direction, active)
values ('email', 0, array[]::text[], null, true)
on conflict (activity_type) where active do nothing;

insert into qualification_rules (activity_type, min_duration_seconds, allowed_results, required_direction, active)
values ('meeting', 0, array[]::text[], null, true)
on conflict (activity_type) where active do nothing;

-- Notes are a human writing something down. They are never "activity" for the
-- purposes of account health, so nothing qualifies.
insert into qualification_rules (activity_type, min_duration_seconds, allowed_results, required_direction, active)
values ('note', 2147483647, array['__never__'], null, true)
on conflict (activity_type) where active do nothing;

-- ---------------------------------------------------------------------------
-- Field definitions
--
-- These are seeded so the account detail form has something to render on first
-- boot. An admin adds more by inserting rows here -- no migration, no deploy.
-- The point of the demo is that this list is data.
-- ---------------------------------------------------------------------------
insert into field_defs (object, key, label, type, options, required, sort) values
  ('account', 'monthly_retainer',  'Monthly Retainer',   'number',  null, false, 10),
  ('account', 'service_tier',      'Service Tier',       'select',
     '["Starter","Growth","Scale","Enterprise"]'::jsonb, false, 20),
  ('account', 'renewal_date',      'Renewal Date',       'date',    null, false, 30),
  ('account', 'referral_source',   'Referral Source',    'select',
     '["Inbound","Referral","Outbound","Event","Partner"]'::jsonb, false, 40),
  ('account', 'referenceable',     'Referenceable',      'boolean', null, false, 50),
  ('account', 'primary_channel',   'Primary Channel',    'select',
     '["Paid Search","Paid Social","SEO","Email","Creative","Full Service"]'::jsonb, false, 60),

  ('contact', 'decision_maker',    'Decision Maker',     'boolean', null, false, 10),
  ('contact', 'preferred_channel', 'Preferred Contact',  'select',
     '["Email","Phone","Text"]'::jsonb, false, 20),
  ('contact', 'reports_to',        'Reports To',         'text',    null, false, 30),

  ('opportunity', 'retainer_months', 'Retainer Length (months)', 'number', null, false, 10),
  ('opportunity', 'competitor',      'Competing Agency',         'text',   null, false, 20),
  ('opportunity', 'loss_reason',     'Loss Reason',              'select',
     '["Price","Timing","Went In-House","Chose Competitor","No Decision"]'::jsonb, false, 30)
on conflict (object, key) do nothing;
