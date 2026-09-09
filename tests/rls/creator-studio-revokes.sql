-- Exact inverse of tests/rls/creator-studio-grants.sql, run during cleanup
-- before the role itself is dropped.

revoke select on creator_posts from :"role_name";
revoke select on creator_templates from :"role_name";
revoke select on creator_generations from :"role_name";
revoke select, insert, update on creator_campaigns from :"role_name";
revoke select, insert, update on creator_profiles from :"role_name";
revoke usage on schema public from :"role_name";
