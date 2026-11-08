-- Written by the 0.2.0 embedded Worker; synthetic local data.
CREATE TABLE _schema(version INTEGER NOT NULL);
INSERT INTO "_schema" VALUES(1);
CREATE TABLE projects(id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, title TEXT, created_at TEXT NOT NULL);
INSERT INTO "projects" VALUES('prj_f6b852d834403188','app_baseline','baseline','2026-11-08T17:27:57.538Z');
