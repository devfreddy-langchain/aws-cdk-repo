-- k8s/db-bootstrap/core.sql — run as the RDS master user by bootstrap.sh (database "langsmith" on <name>-core).
-- Fixed role and database names only: nothing from your settings is put into SQL.
--
-- Per application role: create it with LOGIN, give it its database, and GRANT rds_iam LAST.
-- ORDER MATTERS on RDS: a role that is a member of rds_iam can only log in with an IAM token, and
-- so can every role that inherits it — the master user too, while it is a member of the app role.
-- So ownership is changed through a temporary membership, between REVOKE rds_iam and GRANT rds_iam.
-- (The REVOKE runs only when the role has rds_iam, so a first install prints no warnings.)
-- The psql "gset" and "if" lines skip that part when the database already belongs to the role.

-- The extensions LangSmith needs, first, while the master user still owns the database.
CREATE EXTENSION IF NOT EXISTS btree_gin;
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS ltree;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'langsmith_app') THEN CREATE ROLE langsmith_app LOGIN; END IF; END $$;
SELECT NOT EXISTS (SELECT FROM pg_database WHERE datname = 'langsmith' AND pg_get_userbyid(datdba) = 'langsmith_app') AS need_langsmith \gset
\if :need_langsmith
  DO $$ BEGIN IF pg_has_role('langsmith_app', 'rds_iam', 'MEMBER') THEN REVOKE rds_iam FROM langsmith_app; END IF; END $$;
  GRANT langsmith_app TO CURRENT_USER;
  ALTER DATABASE langsmith OWNER TO langsmith_app;
  REVOKE langsmith_app FROM CURRENT_USER;
\endif
GRANT rds_iam TO langsmith_app;
DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'langsmith_fleet') THEN CREATE ROLE langsmith_fleet LOGIN; END IF; END $$;
SELECT NOT EXISTS (SELECT FROM pg_database WHERE datname = 'langsmith_fleet' AND pg_get_userbyid(datdba) = 'langsmith_fleet') AS need_langsmith_fleet \gset
\if :need_langsmith_fleet
  DO $$ BEGIN IF pg_has_role('langsmith_fleet', 'rds_iam', 'MEMBER') THEN REVOKE rds_iam FROM langsmith_fleet; END IF; END $$;
  GRANT langsmith_fleet TO CURRENT_USER;
  SELECT 'CREATE DATABASE langsmith_fleet OWNER langsmith_fleet' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'langsmith_fleet') \gexec
  ALTER DATABASE langsmith_fleet OWNER TO langsmith_fleet;
  REVOKE langsmith_fleet FROM CURRENT_USER;
\endif
GRANT rds_iam TO langsmith_fleet;
DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'langsmith_insights') THEN CREATE ROLE langsmith_insights LOGIN; END IF; END $$;
SELECT NOT EXISTS (SELECT FROM pg_database WHERE datname = 'langsmith_insights' AND pg_get_userbyid(datdba) = 'langsmith_insights') AS need_langsmith_insights \gset
\if :need_langsmith_insights
  DO $$ BEGIN IF pg_has_role('langsmith_insights', 'rds_iam', 'MEMBER') THEN REVOKE rds_iam FROM langsmith_insights; END IF; END $$;
  GRANT langsmith_insights TO CURRENT_USER;
  SELECT 'CREATE DATABASE langsmith_insights OWNER langsmith_insights' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'langsmith_insights') \gexec
  ALTER DATABASE langsmith_insights OWNER TO langsmith_insights;
  REVOKE langsmith_insights FROM CURRENT_USER;
\endif
GRANT rds_iam TO langsmith_insights;
DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'langsmith_polly') THEN CREATE ROLE langsmith_polly LOGIN; END IF; END $$;
SELECT NOT EXISTS (SELECT FROM pg_database WHERE datname = 'langsmith_polly' AND pg_get_userbyid(datdba) = 'langsmith_polly') AS need_langsmith_polly \gset
\if :need_langsmith_polly
  DO $$ BEGIN IF pg_has_role('langsmith_polly', 'rds_iam', 'MEMBER') THEN REVOKE rds_iam FROM langsmith_polly; END IF; END $$;
  GRANT langsmith_polly TO CURRENT_USER;
  SELECT 'CREATE DATABASE langsmith_polly OWNER langsmith_polly' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'langsmith_polly') \gexec
  ALTER DATABASE langsmith_polly OWNER TO langsmith_polly;
  REVOKE langsmith_polly FROM CURRENT_USER;
\endif
GRANT rds_iam TO langsmith_polly;
