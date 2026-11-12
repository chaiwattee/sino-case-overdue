-- Projects & tasks for the Project Manager team.
-- A project holds milestones; a milestone holds tasks. A task is either done by the PM ("own") or handed to another
-- team ("sr"): handing it over opens a normal service request (service_requests.project_task_id) whose status is
-- read back as the task's status, so the PM never updates those tasks by hand.
CREATE TABLE IF NOT EXISTS projects (
  id           serial PRIMARY KEY,
  name         text NOT NULL,
  customer     text,
  template     text,
  pm_id        int REFERENCES users(id) ON DELETE SET NULL,
  start_date   date NOT NULL,
  end_date     date NOT NULL,
  status       text NOT NULL DEFAULT 'plan' CHECK (status IN ('plan','active','delivered','cancelled')),
  description  text,
  delivered_at date,
  created_by   int REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS projects_pm ON projects (pm_id);

CREATE TABLE IF NOT EXISTS project_milestones (
  id          serial PRIMARY KEY,
  project_id  int NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        text NOT NULL,
  due_date    date NOT NULL,
  sort        int NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS project_milestones_p ON project_milestones (project_id);

CREATE TABLE IF NOT EXISTS project_tasks (
  id            serial PRIMARY KEY,
  project_id    int NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  milestone_id  int REFERENCES project_milestones(id) ON DELETE SET NULL,
  name          text NOT NULL,
  detail        text,
  kind          text NOT NULL CHECK (kind IN ('own','sr')),
  team          text REFERENCES teams(code),
  severity      text NOT NULL DEFAULT 'normal',
  start_date    date NOT NULL,
  due_date      date NOT NULL,          -- current due date
  base_date     date NOT NULL,          -- the first plan, never changed
  kpi_due       date NOT NULL,          -- what the KPI is judged on: moves only when the change was made before the due date
  status        text NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','doing','done','cancelled')),  -- own tasks only
  done_at       date,
  sr_open       text NOT NULL DEFAULT 'now' CHECK (sr_open IN ('now','auto')),  -- 'auto' = open the SR 7 days before start
  md_est        numeric(6,1) NOT NULL DEFAULT 0,
  sort          int NOT NULL DEFAULT 0,
  reminded      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by    int REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS project_tasks_p ON project_tasks (project_id);

ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS project_task_id int REFERENCES project_tasks(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS service_requests_ptask ON service_requests (project_task_id) WHERE project_task_id IS NOT NULL AND status NOT IN ('rejected','cancelled');

-- Activity, man-days and due-date changes of a task (own and handed-over alike).
CREATE TABLE IF NOT EXISTS project_task_events (
  id          serial PRIMARY KEY,
  task_id     int NOT NULL REFERENCES project_tasks(id) ON DELETE CASCADE,
  kind        text NOT NULL,           -- note | status | due | created | sr_opened
  text        text,
  md          numeric(6,1) NOT NULL DEFAULT 0,
  data        jsonb,
  by_user     int REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS project_task_events_t ON project_task_events (task_id);

-- Project documents (task_id set = a file attached to a task's activity).
CREATE TABLE IF NOT EXISTS project_files (
  id          serial PRIMARY KEY,
  project_id  int NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id     int REFERENCES project_tasks(id) ON DELETE CASCADE,
  event_id    int REFERENCES project_task_events(id) ON DELETE SET NULL,
  category    text,
  file_name   text NOT NULL,
  mime        text,
  size        int,
  path        text NOT NULL,
  by_user     int REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS project_files_p ON project_files (project_id);

-- Templates: [{name, tasks:[{name, team|null, start, end, md}]}], start/end in working days from the project start.
CREATE TABLE IF NOT EXISTS project_templates (
  id          serial PRIMARY KEY,
  name        text NOT NULL UNIQUE,
  milestones  jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_by  int REFERENCES users(id) ON DELETE SET NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
INSERT INTO project_templates (name, milestones) VALUES
 ('ติดตั้ง CXone', '[
   {"name":"เริ่มโครงการ","tasks":[{"name":"Kick-off และเก็บ requirement","team":null,"start":0,"end":5,"md":2},{"name":"ส่งแผนงานให้ลูกค้าลงนาม","team":null,"start":4,"end":7,"md":1}]},
   {"name":"ติดตั้งระบบ","tasks":[{"name":"ติดตั้ง server และ network","team":"ENGAGE","start":8,"end":16,"md":4},{"name":"ติดตั้ง CXone agent และ softphone","team":"ENGAGE","start":14,"end":21,"md":3}]},
   {"name":"ตั้งค่าและเชื่อมต่อ","tasks":[{"name":"ตั้งค่า IVR / Routing","team":"ENGAGE","start":22,"end":28,"md":3},{"name":"เชื่อมต่อ CRM","team":"DEV","start":22,"end":32,"md":5}]},
   {"name":"UAT และส่งมอบ","tasks":[{"name":"เตรียมเอกสาร UAT","team":null,"start":30,"end":36,"md":2},{"name":"UAT กับลูกค้า","team":null,"start":38,"end":42,"md":3},{"name":"อบรมผู้ใช้งาน","team":"ENGAGE","start":43,"end":45,"md":2},{"name":"ส่งมอบและปิดโครงการ","team":null,"start":46,"end":50,"md":1}]}
 ]'::jsonb),
 ('ติดตั้ง WFM', '[
   {"name":"เริ่มโครงการ","tasks":[{"name":"Kick-off","team":null,"start":0,"end":4,"md":1}]},
   {"name":"ติดตั้ง","tasks":[{"name":"ติดตั้ง WFM server","team":"WFM","start":5,"end":14,"md":4},{"name":"นำเข้าข้อมูล historical","team":"WFM","start":10,"end":20,"md":3}]},
   {"name":"ส่งมอบ","tasks":[{"name":"UAT","team":null,"start":25,"end":30,"md":2},{"name":"อบรม","team":"WFM","start":31,"end":33,"md":2}]}
 ]'::jsonb)
ON CONFLICT (name) DO NOTHING;
