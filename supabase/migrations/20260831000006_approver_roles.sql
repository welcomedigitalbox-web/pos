-- =====================================================================
-- PIN approvers after the role split
-- Repo path: supabase/migrations/20260831000006_approver_roles.sql
--
-- is_approver_role() still listed 'manager', which no longer exists.
-- Every department head lost the ability to authorise a discount at the
-- till the moment the roles were split, leaving only admin and owner.
-- =====================================================================

create or replace function public.is_approver_role(p_role text)
returns boolean
language sql
immutable
as $$
  -- Department heads and above. 'manager' predates the split into one
  -- head per department and is kept so any row still carrying it works.
  select p_role in (
    -- Only the sale side signs off at the till. A warehouse or finance
    -- head outranks a cashier but has no business discounting a sale, and
    -- the PIN check has no store to test them against.
    'admin', 'owner', 'operation_director',
    'sale_manager',
    'manager'
  );
$$;
