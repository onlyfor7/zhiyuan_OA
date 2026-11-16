-- 迭代 20 工单 02：dept_head / to_dept_head 审批人策略存储（arch/14 §6 假定 18-01 已就位，实测 org_units 无 leader 列——偏差与仲裁登记 G-20-2-1）
-- 追加式：仅加可空列 + 索引，不动既有列/数据
ALTER TABLE org_units ADD COLUMN IF NOT EXISTS leader_id uuid NULL;
CREATE INDEX IF NOT EXISTS org_units_leader_id_idx ON org_units (leader_id);
