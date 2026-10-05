-- k8s/db-bootstrap/metastore.sql — run as the RDS master user by bootstrap.sh (database "smithdb" on <name>-metastore).
-- Fixed role and database names only: nothing from your settings is put into SQL.
--
-- Per application role: create it with LOGIN, give it its database, and GRANT rds_iam LAST.
-- ORDER MATTERS on RDS: a role that is a member of rds_iam can only log in with an IAM token, and
-- so can every role that inherits it — the master user too, while it is a member of the app role.
-- So ownership is changed through a temporary membership, between REVOKE rds_iam and GRANT rds_iam.
-- (The REVOKE runs only when the role has rds_iam, so a first install prints no warnings.)
-- The psql "gset" and "if" lines skip that part when the database already belongs to the role.

DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'smithdb_app') THEN CREATE ROLE smithdb_app LOGIN; END IF; END $$;
SELECT NOT EXISTS (SELECT FROM pg_database WHERE datname = 'smithdb' AND pg_get_userbyid(datdba) = 'smithdb_app') AS need_smithdb \gset
\if :need_smithdb
  DO $$ BEGIN IF pg_has_role('smithdb_app', 'rds_iam', 'MEMBER') THEN REVOKE rds_iam FROM smithdb_app; END IF; END $$;
  GRANT smithdb_app TO CURRENT_USER;
  ALTER DATABASE smithdb OWNER TO smithdb_app;
  REVOKE smithdb_app FROM CURRENT_USER;
\endif
GRANT rds_iam TO smithdb_app;
