-- 0006_freight_fields.sql
--
-- Replace the placeholder field set with the ones a freight broker actually
-- fills in on a shipper prospect.
--
-- Note what this migration is: rows. Adding, renaming or retiring a field on
-- the account form is an INSERT or an UPDATE here, never a schema change and
-- never a deploy. That is the whole point of field_defs, and this file is the
-- proof -- the account detail page was not touched to make any of this appear.

-- Retire the marketing fields rather than deleting them. Archiving keeps any
-- values already sitting in accounts.custom recoverable; a delete would leave
-- orphaned jsonb nobody can find again.
update field_defs set archived = true
 where object = 'account'
   and key in ('monthly_retainer','service_tier','renewal_date','referral_source',
               'referenceable','primary_channel');

update field_defs set archived = true
 where object = 'opportunity' and key in ('retainer_months','competitor');

insert into field_defs (object, key, label, type, options, required, sort) values
  ('account', 'annual_freight_spend', 'Annual Freight Spend', 'number', null, false, 10),
  ('account', 'volume_band',          'Shipping Volume',      'select',
     '["1-5 loads/wk","5-20 loads/wk","20-50 loads/wk","50+ loads/wk"]'::jsonb, false, 20),
  ('account', 'primary_mode',         'Primary Mode',         'select',
     '["Dry Van","Reefer","Flatbed","LTL","Intermodal","Expedited"]'::jsonb, false, 30),
  ('account', 'shipping_from',        'Ships From',           'text',   null, false, 40),
  ('account', 'lead_source',          'Lead Source',          'select',
     '["Cold Call","Inbound","Referral","Trade Show","Salesforce Import","List Purchase"]'::jsonb, false, 50),
  -- The handoff point. Once an account converts, Salesforce owns the customer
  -- relationship and this is the thread back to it.
  ('account', 'salesforce_id',        'Salesforce ID',        'text',   null, false, 60),

  ('contact', 'decision_maker',    'Decision Maker',    'boolean', null, false, 10),
  ('contact', 'preferred_channel', 'Preferred Contact', 'select',
     '["Email","Phone","Text"]'::jsonb, false, 20),
  ('contact', 'best_time',         'Best Time to Call', 'select',
     '["Early morning","Mid morning","Afternoon","Late afternoon"]'::jsonb, false, 30)
on conflict (object, key) do update
  set label = excluded.label,
      type = excluded.type,
      options = excluded.options,
      sort = excluded.sort,
      archived = false;
