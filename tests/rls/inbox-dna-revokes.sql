-- Exact inverse of tests/rls/inbox-dna-grants.sql, run during cleanup before
-- the role itself is dropped.

revoke select on inbox_mailboxes from :"role_name";
revoke select on inbox_messages from :"role_name";
revoke select, insert on inbox_threads from :"role_name";
revoke select, insert, update, delete on business_dna from :"role_name";
revoke usage on schema public from :"role_name";
