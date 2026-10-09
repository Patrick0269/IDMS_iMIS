import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../../../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("institutional index is the root homepage and contains the managed academic sections", async () => {
  const html = await read("apps/frontend/index.html");
  const script = await read("apps/frontend/assets/js/public-site.js");
  for (const id of ["mainNavigation", "home", "news", "programmes", "statistics", "resources", "contact", "siteFooterAbout", "siteFooterAcademic", "siteSocialLinks"]) {
    assert.match(html, new RegExp(`id=[\"']${id}[\"']`), `${id} should be present on index.html`);
  }
  assert.match(html, /assets\/js\/public-site\.js/);
  assert.match(script, /websitePreview/);
  assert.match(script, /public\/programmes/);
  assert.match(script, /prefers-reduced-motion/);
});

test("public website API protects editing and publishing while serving only published material", async () => {
  const routes = await read("apps/backend/src/modules/website/public-site.routes.ts");
  assert.match(routes, /router\.put\([\s\S]*?\/website\/content[\s\S]*?authenticate, requirePermission\("website\.content\.manage"\)/);
  assert.match(routes, /router\.post\([\s\S]*?\/website\/content\/publish[\s\S]*?authenticate, requirePermission\("website\.content\.manage"\)/);
  assert.match(routes, /router\.post\([\s\S]*?\/website\/revisions\/:id\/restore[\s\S]*?authenticate, requirePermission\("website\.content\.manage"\)/);
  assert.match(routes, /router\.get\("\/public\/site-page\/:slug"/);
  assert.match(routes, /router\.get\("\/public\/site-items"/);
  assert.match(routes, /in\("status", \["PUBLISHED", "SCHEDULED"\]\)/);
  assert.match(routes, /!\["NEWS", "NOTICE", "PAGE"\]\.includes\(itemType\)/);
});

test("applicant registration is mounted at the route used by the applicant portal and checked at startup", async () => {
  const routes = await read("apps/backend/src/modules/auth/routes/auth.routes.ts");
  const mounts = await read("apps/backend/src/routes/index.ts");
  const page = await read("apps/frontend/assets/js/applicant-access.js");
  const startup = await read("Start-IDMC.ps1");
  assert.match(routes, /router\.post\("\/applicant-register"/);
  assert.match(mounts, /router\.use\("\/auth", authRoutes\)/);
  assert.match(page, /\/auth\/applicant-register/);
  assert.match(startup, /Applicant registration API route check failed/);
  assert.match(startup, /Test-UnauthenticatedApiRoute -Method POST/);
});


test("website publishing migration keeps revisions and content items behind service-role RLS", async () => {
  const sql = await read("supabase/migrations/20261009210000_public_website_publishing.sql");
  assert.match(sql, /ADD COLUMN IF NOT EXISTS draft_content jsonb/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.idmc_public_site_revisions/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.idmc_public_site_items/);
  assert.match(sql, /'NEWS','NOTICE','PAGE'/);
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /REVOKE ALL ON TABLE public\.idmc_public_site_items FROM anon, authenticated/);
  assert.match(sql, /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public\.idmc_public_site_items TO service_role/);
});

test("content manager offers pages, notices, news and draft preview/publish controls", async () => {
  const html = await read("apps/frontend/website-content.html");
  const js = await read("apps/frontend/assets/js/website-content.js");
  assert.match(html, /name="itemType"[\s\S]*?value="PAGE"/);
  assert.match(html, /id="newPageItem"/);
  assert.match(html, /name="searchVisible"/);
  assert.match(html, /id="previewWebsiteContent"/);
  assert.match(html, /id="publishWebsiteContent"/);
  assert.match(js, /website\/content\/publish/);
  assert.match(js, /website\/revisions/);
});
