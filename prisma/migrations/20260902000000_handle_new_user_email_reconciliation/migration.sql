-- Fixes a real production/staging defect in public.handle_new_user(): a
-- fresh Supabase Auth identity (new auth.users.id) created for an email
-- that already has a public.users row aborts the *entire* auth.users
-- INSERT transaction with "duplicate key value violates unique constraint
-- users_email_key" -- the Admin API surfaces this as a 500.
--
-- This happens whenever an auth.users row is deleted and a new one is
-- created for the same email (there is no auth.users DELETE trigger that
-- removes or reconciles the corresponding public.users row -- by design,
-- since deleting it would destroy that person's org membership/activity/
-- message history for no reason). The prior implementation only guarded
-- `ON CONFLICT (id)`, which does nothing when the id differs but the email
-- already exists under a stale row.
--
-- Fix: before inserting, reconcile any existing public.users row that has
-- the same email but a different id onto the new auth id. Every foreign
-- key referencing users.id (organization_members, activities, messages,
-- notifications) is already ON UPDATE CASCADE (see the initial baseline
-- migration), so retargeting the row's id here is safe and preserves every
-- existing relationship instead of leaving it permanently orphaned.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.users
  SET id = NEW.id,
      full_name = coalesce(NEW.raw_user_meta_data ->> 'full_name', full_name),
      avatar_url = coalesce(NEW.raw_user_meta_data ->> 'avatar_url', avatar_url),
      updated_at = now()
  WHERE email = NEW.email AND id <> NEW.id;

  INSERT INTO public.users (
    id, email, full_name, avatar_url, created_at, updated_at
  ) VALUES (
    NEW.id,
    NEW.email,
    NEW.raw_user_meta_data ->> 'full_name',
    NEW.raw_user_meta_data ->> 'avatar_url',
    now(),
    now()
  )
  ON CONFLICT (id) DO NOTHING;

  RETURN NEW;
END;
$$;
