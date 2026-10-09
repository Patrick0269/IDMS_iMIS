BEGIN;

ALTER TABLE public.idmc_public_site_content
  ADD COLUMN IF NOT EXISTS draft_content jsonb,
  ADD COLUMN IF NOT EXISTS published_at timestamptz,
  ADD COLUMN IF NOT EXISTS published_by uuid REFERENCES public.users(id) ON DELETE SET NULL;

UPDATE public.idmc_public_site_content
SET draft_content = content
WHERE draft_content IS NULL;

UPDATE public.idmc_public_site_content
SET content = content || '{
  "siteName":"Institute of Development and Medical Sciences",
  "tagline":"Knowledge · Service · Development",
  "navigation":[
    {"label":"Home","url":"#home","visible":true},
    {"label":"About IDMS","url":"#about","subLabel1":"Our Institute","subUrl1":"#campuses","subLabel2":"Contact Us","subUrl2":"#contact","visible":true},
    {"label":"Academic Programmes","url":"#programmes","subLabel1":"Current Programmes","subUrl1":"#programmes","subLabel2":"Apply Online","subUrl2":"/applicant-access.html","visible":true},
    {"label":"Admissions","url":"#admissions","subLabel1":"Applicant Sign In","subUrl1":"/applicant-access.html","visible":true},
    {"label":"Student Services","url":"#services","visible":true},
    {"label":"News & Events","url":"#news","visible":true},
    {"label":"Contact Us","url":"#contact","visible":true}
  ],
  "slides":[],
  "quickLinks":[
    {"label":"Apply Online","url":"/applicant-access.html","description":"Start or continue an application","visible":true},
    {"label":"Applicant Login","url":"/applicant-access.html","description":"Applicant account access","visible":true},
    {"label":"Student Portal","url":"/login.html","description":"Student services","visible":true},
    {"label":"Staff Portal","url":"/login.html","description":"Staff services","visible":true},
    {"label":"Academic Programmes","url":"#programmes","description":"Browse active programmes","visible":true}
  ],
  "statistics":[],
  "resources":[
    {"label":"Student Services","url":"#services","group":"Student Support","visible":true},
    {"label":"Academic Programmes","url":"#programmes","group":"Academic","visible":true},
    {"label":"Admissions","url":"#admissions","group":"Admissions","visible":true},
    {"label":"Contact IDMS","url":"#contact","group":"Institute","visible":true}
  ],
  "media":[],
  "socialLinks":[],
  "footerAbout":[{"label":"Overview","url":"#about","visible":true},{"label":"Institute Information","url":"#campuses","visible":true}],
  "footerAcademic":[{"label":"Programmes","url":"#programmes","visible":true},{"label":"Admissions","url":"#admissions","visible":true}],
  "footerStudentServices":[{"label":"Student Portal","url":"/login.html","visible":true},{"label":"Applicant Portal","url":"/applicant-access.html","visible":true}],
  "footerQuickLinks":[{"label":"Apply Online","url":"/applicant-access.html","visible":true},{"label":"Contact Us","url":"#contact","visible":true}]
}'::jsonb,
    draft_content = coalesce(draft_content, content) || '{
  "siteName":"Institute of Development and Medical Sciences",
  "tagline":"Knowledge · Service · Development",
  "navigation":[{"label":"Home","url":"#home","visible":true},{"label":"About IDMS","url":"#about","subLabel1":"Our Institute","subUrl1":"#campuses","visible":true},{"label":"Academic Programmes","url":"#programmes","subLabel1":"Apply Online","subUrl1":"/applicant-access.html","visible":true},{"label":"Admissions","url":"#admissions","visible":true},{"label":"Student Services","url":"#services","visible":true},{"label":"News & Events","url":"#news","visible":true},{"label":"Contact Us","url":"#contact","visible":true}],
  "slides":[],"quickLinks":[{"label":"Apply Online","url":"/applicant-access.html","description":"Start or continue an application","visible":true},{"label":"Applicant Login","url":"/applicant-access.html","description":"Applicant account access","visible":true},{"label":"Student Portal","url":"/login.html","description":"Student services","visible":true},{"label":"Staff Portal","url":"/login.html","description":"Staff services","visible":true},{"label":"Academic Programmes","url":"#programmes","description":"Browse active programmes","visible":true}],
  "statistics":[],"resources":[{"label":"Student Services","url":"#services","group":"Student Support","visible":true},{"label":"Academic Programmes","url":"#programmes","group":"Academic","visible":true},{"label":"Admissions","url":"#admissions","group":"Admissions","visible":true},{"label":"Contact IDMS","url":"#contact","group":"Institute","visible":true}],"media":[],"socialLinks":[],
  "footerAbout":[{"label":"Overview","url":"#about","visible":true},{"label":"Institute Information","url":"#campuses","visible":true}],"footerAcademic":[{"label":"Programmes","url":"#programmes","visible":true},{"label":"Admissions","url":"#admissions","visible":true}],"footerStudentServices":[{"label":"Student Portal","url":"/login.html","visible":true},{"label":"Applicant Portal","url":"/applicant-access.html","visible":true}],"footerQuickLinks":[{"label":"Apply Online","url":"/applicant-access.html","visible":true},{"label":"Contact Us","url":"#contact","visible":true}]
}'::jsonb
WHERE content_key = 'homepage';

CREATE TABLE IF NOT EXISTS public.idmc_public_site_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content_key text NOT NULL DEFAULT 'homepage' CHECK (content_key = 'homepage'),
  content jsonb NOT NULL,
  change_kind text NOT NULL CHECK (change_kind IN ('PUBLISHED','RESTORED')),
  changed_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  changed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.idmc_public_site_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_type text NOT NULL CHECK (item_type IN ('NEWS','NOTICE','PAGE')),
  slug text NOT NULL UNIQUE,
  title varchar(240) NOT NULL,
  summary varchar(1200) NOT NULL DEFAULT '',
  body text NOT NULL DEFAULT '',
  category varchar(100) NOT NULL DEFAULT 'General',
  image_url text,
  attachment_url text,
  link_url text,
  featured boolean NOT NULL DEFAULT false,
  search_visible boolean NOT NULL DEFAULT true,
  seo_title varchar(180),
  seo_description varchar(320),
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','SCHEDULED','PUBLISHED','ARCHIVED')),
  publish_at timestamptz,
  expire_at timestamptz,
  created_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  published_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  CHECK (expire_at IS NULL OR publish_at IS NULL OR expire_at >= publish_at)
);

ALTER TABLE public.idmc_public_site_items DROP CONSTRAINT IF EXISTS idmc_public_site_items_item_type_check;
ALTER TABLE public.idmc_public_site_items ADD CONSTRAINT idmc_public_site_items_item_type_check CHECK (item_type IN ('NEWS','NOTICE','PAGE'));

CREATE INDEX IF NOT EXISTS idx_idmc_public_site_items_public
  ON public.idmc_public_site_items(item_type, status, publish_at DESC, featured DESC);

ALTER TABLE public.idmc_public_site_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.idmc_public_site_items ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.idmc_public_site_revisions FROM anon, authenticated;
REVOKE ALL ON TABLE public.idmc_public_site_items FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.idmc_public_site_revisions TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.idmc_public_site_items TO service_role;

COMMIT;
