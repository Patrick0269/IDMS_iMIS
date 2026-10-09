BEGIN;

CREATE TABLE IF NOT EXISTS public.idmc_public_site_content (
  content_key text PRIMARY KEY CHECK (content_key = 'homepage'),
  content jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.idmc_public_site_content ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.idmc_public_site_content FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.idmc_public_site_content TO service_role;

INSERT INTO public.permissions(permission_code, permission_name, module_code, action_code, description, status)
VALUES ('website.content.manage', 'Manage public website content', 'WEBSITE', 'MANAGE', 'Edit the public IDMC homepage copy and images.', 'ACTIVE')
ON CONFLICT (permission_code) DO UPDATE SET permission_name = EXCLUDED.permission_name, description = EXCLUDED.description, status = 'ACTIVE';

INSERT INTO public.role_permissions(role_id, permission_id)
SELECT r.id, p.id FROM public.roles r CROSS JOIN public.permissions p
WHERE r.role_code IN ('ADMIN', 'SUPER_ADMIN', 'SYSTEM_ADMIN') AND p.permission_code = 'website.content.manage'
ON CONFLICT (role_id, permission_id) DO NOTHING;

INSERT INTO public.idmc_public_site_content(content_key, content)
VALUES ('homepage', '{
  "heroEyebrow":"Welcome to IDMC",
  "heroTitle":"Education for development, leadership and service.",
  "heroDescription":"The Institute of Development and Medical Sciences provides practical, accessible and professionally focused education supported by an integrated digital academic management system.",
  "announcementTitle":"Admissions and academic updates",
  "announcementText":"Check this space for current admission rounds, important dates and official institute notices.",
  "aboutEyebrow":"About the Institute",
  "aboutTitle":"Preparing graduates for professional and community impact.",
  "aboutTextOne":"IDMC provides competency-based education that connects classroom learning with practical institutional, business and community needs.",
  "aboutTextTwo":"Our integrated information system supports applicants, students, lecturers and administrators throughout the complete academic lifecycle.",
  "programmeEyebrow":"Academic Programmes",
  "programmeTitle":"Learn through programmes designed for practice.",
  "programmeIntro":"Explore current programmes and submit an online application through the applicant portal.",
  "programmeCodeOne":"PPBA","programmeNameOne":"Project Planning and Business Administration","programmeTextOne":"Professional knowledge in project planning, management, entrepreneurship and institutional administration.",
  "programmeCodeTwo":"SW","programmeNameTwo":"Social Work","programmeTextTwo":"Skills for community engagement, social development, welfare services and responsible professional practice.",
  "campusTitle":"Learning rooted in Tanzania","campusText":"Explore IDMC programmes, student support and practical learning opportunities.",
  "campusNameOne":"Academic Programmes","campusTextOne":"Competency-based learning connected to professional practice.",
  "campusNameTwo":"Student Services","campusTextTwo":"Support for registration, learning, wellbeing and progression.",
  "campusNameThree":"Community Engagement","campusTextThree":"Professional knowledge applied to community development.",
  "admissionsTitle":"Start your application to IDMC.",
  "admissionsText":"Complete your profile, qualifications, programme choice and supporting documents through the secure online application portal.",
  "contactTitle":"Get in touch with IDMC.",
  "admissionsEmail":"admissions@idms.ac.tz","generalEmail":"info@idms.ac.tz",
  "portalTitle":"IDMC iMIS Access",
  "footerInstituteName":"Institute of Development and Medical Sciences",
  "footerInstituteText":"Integrated academic and institutional services supporting students, staff and the wider community.",
  "heroImage":"","aboutImage":"","programmeImageOne":"","programmeImageTwo":"","campusImageOne":"","campusImageTwo":"","campusImageThree":""
}'::jsonb)
ON CONFLICT (content_key) DO NOTHING;

COMMIT;
