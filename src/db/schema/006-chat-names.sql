ALTER TABLE dispatches ADD COLUMN chat_name TEXT;
UPDATE dispatches
SET chat_name = COALESCE(NULLIF(json_extract(extra, '$.label'), ''), NULLIF(branch, ''), id);
