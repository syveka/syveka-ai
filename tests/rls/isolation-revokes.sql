-- Exact inverse of tests/rls/isolation-grants.sql, run during cleanup before
-- the role itself is dropped.

revoke select, update on notifications from :"role_name";
revoke select, update on prompts from :"role_name";
revoke select, update on webhook_endpoints from :"role_name";
revoke select, update on voice_assistants from :"role_name";
revoke select, update on workflows from :"role_name";
revoke select, update on documents from :"role_name";
revoke select, update on collections from :"role_name";
revoke select, update on conversations from :"role_name";
revoke select, update on calendar_events from :"role_name";
revoke select, update on activities from :"role_name";
revoke select, update on deals from :"role_name";
revoke select, update on tags from :"role_name";
revoke select, update on pipelines from :"role_name";
revoke select, update on companies from :"role_name";
revoke select, update on teams from :"role_name";
revoke insert on subscriptions from :"role_name";
revoke select on organizations from :"role_name";
revoke select, insert on contacts from :"role_name";
revoke usage on schema public from :"role_name";
