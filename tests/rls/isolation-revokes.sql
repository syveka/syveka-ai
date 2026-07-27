-- Exact inverse of tests/rls/isolation-grants.sql, run during cleanup before
-- the role itself is dropped.

revoke insert on subscriptions from :"role_name";
revoke select on organizations from :"role_name";
revoke select, insert on contacts from :"role_name";
revoke usage on schema public from :"role_name";
