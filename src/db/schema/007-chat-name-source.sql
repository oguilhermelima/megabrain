WITH RECURSIVE path_parts(id, remainder) AS (
  SELECT id, trim(worktree_path, '/')
  FROM dispatches
  WHERE worktree_path IS NOT NULL
    AND chat_name = agent || ' ' || worktree_path
  UNION ALL
  SELECT id, substr(remainder, instr(remainder, '/') + 1)
  FROM path_parts
  WHERE instr(remainder, '/') > 0
)
UPDATE dispatches
SET chat_name = COALESCE(
  NULLIF(branch, ''),
  (SELECT NULLIF(remainder, '') FROM path_parts WHERE path_parts.id = dispatches.id AND instr(remainder, '/') = 0),
  id
)
WHERE worktree_path IS NOT NULL
  AND chat_name = agent || ' ' || worktree_path;
