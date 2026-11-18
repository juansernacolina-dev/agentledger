-- Runs once, when the postgres volume is first created.
-- A separate database keeps integration tests away from local demo data.
CREATE DATABASE agentledger_test OWNER CURRENT_USER;
