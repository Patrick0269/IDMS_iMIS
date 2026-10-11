import { Router, type NextFunction, type Request, type Response } from "express";
import { getSupabase } from "../../config/database.js";
import { authenticate } from "../../middleware/auth.js";
import { requirePermission } from "../../middleware/rbac.js";
import { createAuditLog } from "../../services/audit.service.js";
import { privateDocumentMatchesMime } from "../../utils/private-document-validation.js";
import { escapeIlikeLiteral } from "../../utils/security.js";

const router = Router();
const textFields: Record<string, number> = {
  programmeCodeOne: 40, programmeNameOne: 180, programmeTextOne: 800, programmeCodeTwo: 40, programmeNameTwo: 180, programmeTextTwo: 800,
  siteName: 180, tagline: 240, address: 500, phone: 100, officeHours: 160, mapUrl: 1200,
  heroEyebrow: 120, heroTitle: 240, heroDescription: 1600, announcementTitle: 180, announcementText: 1200,
  aboutEyebrow: 120, aboutTitle: 240, aboutTextOne: 1200, aboutTextTwo: 1200,
  programmeEyebrow: 120, programmeTitle: 240, programmeIntro: 1000,
  campusTitle: 240, campusText: 1000, campusNameOne: 140, campusTextOne: 700, campusNameTwo: 140, campusTextTwo: 700,
  campusNameThree: 140, campusTextThree: 700, admissionsTitle: 240, admissionsText: 1200, contactTitle: 180,
  admissionsEmail: 255, generalEmail: 255, portalTitle: 160, footerInstituteName: 180, footerInstituteText: 700,
  copyright: 240, seoTitle: 180, seoDescription: 320, seoCanonicalUrl: 1200,
  defaultLanguage: 12,
};
const imageKeys = new Set(["logoUrl", "faviconUrl", "heroImage", "aboutImage", "programmeImageOne", "programmeImageTwo", "campusImageOne", "campusImageTwo", "campusImageThree", "seoImage"]);
const collectionFields: Record<string, Record<string, number | "boolean">> = {
  navigation: { label: 80, url: 1200, visible: "boolean", subLabel1: 80, subUrl1: 1200, subLabel2: 80, subUrl2: 1200 },
  slides: { title: 180, description: 700, imageUrl: 1200, imageAlt: 180, buttonLabel: 50, buttonUrl: 1200, startsAt: 40, endsAt: 40, enabled: "boolean" },
  quickLinks: { label: 80, url: 1200, description: 240, icon: 40, group: 80, visible: "boolean" },
  statistics: { label: 80, value: 40, source: 240, updatedAt: 40, visible: "boolean" },
  resources: { label: 100, url: 1200, group: 80, visible: "boolean" },
  media: { title: 160, description: 400, mediaUrl: 1200, coverUrl: 1200, mediaType: 20, visible: "boolean" },
  socialLinks: { label: 60, url: 1200, visible: "boolean" },
  footerAbout: { label: 80, url: 1200, visible: "boolean" },
  footerAcademic: { label: 80, url: 1200, visible: "boolean" },
  footerStudentServices: { label: 80, url: 1200, visible: "boolean" },
  footerQuickLinks: { label: 80, url: 1200, visible: "boolean" },
};
const fail = (res: Response, status: number, message: string) => res.status(status).json({ success: false, message });
function handler(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => { void fn(req, res).catch(next); };
}
function validateUrl(value: string, field: string, allowDataImage = false) {
  if (!value) return;
  if (allowDataImage && value.startsWith("data:")) return;
  if (value.startsWith("/") && !value.startsWith("//")) return;
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw Object.assign(new Error(`${field} must be an internal route or secure URL.`), { statusCode: 400 }); }
  if (!["https:", "mailto:", "tel:"].includes(parsed.protocol)) throw Object.assign(new Error(`${field} must use HTTPS or an approved contact link.`), { statusCode: 400 });
}
function validateImage(value: unknown, key: string): string {
  if (typeof value !== "string" || value.length > 1_500_000) throw Object.assign(new Error(`${key} is too large or invalid.`), { statusCode: 400 });
  if (!value) return "";
  if (value.startsWith("data:")) {
    const match = value.match(/^data:(image\/(?:png|jpeg|webp|x-icon|vnd\.microsoft\.icon));base64,([A-Za-z0-9+/]+={0,2})$/);
    if (!match) throw Object.assign(new Error(`${key} must be a PNG, JPEG, WebP or icon image.`), { statusCode: 400 });
    const bytes = Buffer.from(match[2]!, "base64");
    if (bytes.length > 1_000_000 || !privateDocumentMatchesMime(bytes, match[1]!)) throw Object.assign(new Error(`${key} is not a valid image or exceeds 1 MB.`), { statusCode: 400 });
    return value;
  }
  validateUrl(value, key);
  return value;
}
function validateCollection(key: string, value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length > 30) throw Object.assign(new Error(`${key} must contain no more than 30 items.`), { statusCode: 400 });
  const definition = collectionFields[key]!;
  return value.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw Object.assign(new Error(`${key}[${index}] must be an object.`), { statusCode: 400 });
    const source = raw as Record<string, unknown>, row: Record<string, unknown> = {};
    const extra = Object.keys(source).find((name) => !(name in definition));
    if (extra) throw Object.assign(new Error(`${key}[${index}] has an unsupported field.`), { statusCode: 400 });
    for (const [name, max] of Object.entries(definition)) {
      const item = source[name];
      if (item === undefined) continue;
      if (max === "boolean") {
        if (typeof item !== "boolean") throw Object.assign(new Error(`${key}[${index}].${name} must be true or false.`), { statusCode: 400 });
        row[name] = item;
      } else {
        if (typeof item !== "string" || item.length > max) throw Object.assign(new Error(`${key}[${index}].${name} is too long or invalid.`), { statusCode: 400 });
        const imageField = name === "imageUrl" || name === "coverUrl";
        if (imageField && item.startsWith("data:")) row[name] = validateImage(item, `${key}[${index}].${name}`);
        else { if (["url", "subUrl1", "subUrl2", "buttonUrl", "mediaUrl", "imageUrl", "coverUrl"].includes(name)) validateUrl(item, `${key}[${index}].${name}`); row[name] = item.trim(); }
      }
    }
    return row;
  });
}
function validateContent(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw Object.assign(new Error("Website content must be an object."), { statusCode: 400 });
  const source = input as Record<string, unknown>, allowed = new Set([...Object.keys(textFields), ...imageKeys, ...Object.keys(collectionFields)]);
  const extra = Object.keys(source).find((key) => !allowed.has(key));
  if (extra) throw Object.assign(new Error(`Unsupported website content field: ${extra}`), { statusCode: 400 });
  const output: Record<string, unknown> = {};
  for (const [key, max] of Object.entries(textFields)) {
    const value = source[key];
    if (value === undefined) continue;
    if (typeof value !== "string" || value.length > max) throw Object.assign(new Error(`${key} must be text of ${max} characters or fewer.`), { statusCode: 400 });
    output[key] = value.trim();
    if (key === "seoCanonicalUrl" || key === "mapUrl") validateUrl(value.trim(), key);
    if ((key === "admissionsEmail" || key === "generalEmail") && value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw Object.assign(new Error(`${key} must be a valid email address.`), { statusCode: 400 });
  }
  for (const key of imageKeys) if (source[key] !== undefined) output[key] = validateImage(source[key], key);
  for (const key of Object.keys(collectionFields)) if (source[key] !== undefined) output[key] = validateCollection(key, source[key]);
  return output;
}

function validateEntry(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw Object.assign(new Error("Content item must be an object."), { statusCode: 400 });
  const source = input as Record<string, unknown>;
  const fields = ["itemType", "slug", "title", "summary", "body", "category", "imageUrl", "attachmentUrl", "linkUrl", "featured", "status", "publishAt", "expireAt", "searchVisible", "seoTitle", "seoDescription"];
  const extra = Object.keys(source).find((key) => !fields.includes(key));
  if (extra) throw Object.assign(new Error("Content item contains an unsupported field."), { statusCode: 400 });
  const itemType = String(source.itemType ?? "").toUpperCase(), status = String(source.status ?? "DRAFT").toUpperCase();
  if (!["NEWS", "NOTICE", "PAGE"].includes(itemType) || !["DRAFT", "SCHEDULED", "PUBLISHED", "ARCHIVED"].includes(status)) throw Object.assign(new Error("Choose a valid content type and publishing status."), { statusCode: 400 });
  const slug = String(source.slug ?? "").trim().toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 180) throw Object.assign(new Error("Use a URL slug with lowercase letters, numbers and hyphens."), { statusCode: 400 });
  const string = (name: string, max: number, optional = true) => { const value = String(source[name] ?? "").trim(); if (!optional && !value || value.length > max) throw Object.assign(new Error(`${name} is required or too long.`), { statusCode: 400 }); return value; };
  const imageUrl = string("imageUrl", 1_500_000); if (imageUrl.startsWith("data:")) validateImage(imageUrl, "imageUrl"); else validateUrl(imageUrl, "imageUrl");
  const attachmentUrl = string("attachmentUrl", 1200); validateUrl(attachmentUrl, "attachmentUrl");
  const linkUrl = string("linkUrl", 1200); validateUrl(linkUrl, "linkUrl");
  if (typeof source.featured !== "boolean") throw Object.assign(new Error("featured must be true or false."), { statusCode: 400 });
  const publishAt = string("publishAt", 40), expireAt = string("expireAt", 40);
  if (publishAt && !Number.isFinite(Date.parse(publishAt)) || expireAt && !Number.isFinite(Date.parse(expireAt))) throw Object.assign(new Error("Publication dates must be valid dates."), { statusCode: 400 });
  if (status === "SCHEDULED" && !publishAt) throw Object.assign(new Error("A scheduled item needs a publication date."), { statusCode: 400 });
  if (publishAt && expireAt && Date.parse(expireAt) < Date.parse(publishAt)) throw Object.assign(new Error("Expiry date cannot be before the publication date."), { statusCode: 400 });
  const searchVisible = source.searchVisible === undefined ? true : source.searchVisible;
  if (typeof searchVisible !== "boolean") throw Object.assign(new Error("searchVisible must be true or false."), { statusCode: 400 });
  return { item_type: itemType, slug, title: string("title", 240, false), summary: string("summary", 1200), body: string("body", 20_000), category: string("category", 100) || "General", image_url: imageUrl || null, attachment_url: attachmentUrl || null, link_url: linkUrl || null, featured: source.featured, search_visible: searchVisible, seo_title: string("seoTitle", 180) || null, seo_description: string("seoDescription", 320) || null, status, publish_at: publishAt || null, expire_at: expireAt || null };
}

router.get("/public/site-content", handler(async (_req, res) => {
  const result = await getSupabase().from("idmc_public_site_content").select("content,updated_at,published_at").eq("content_key", "homepage").maybeSingle();
  if (result.error) throw result.error;
  res.setHeader("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
  res.json({ success: true, data: result.data?.content ?? {} });
}));

router.get("/public/site-items", handler(async (req, res) => {
  const type = String(req.query.type ?? "").toUpperCase();
  if (!type || !["NEWS", "NOTICE"].includes(type)) return void fail(res, 400, "Choose NEWS or NOTICE.");
  const now = new Date().toISOString();
  let query = getSupabase().from("idmc_public_site_items").select("id,item_type,slug,title,summary,body,category,image_url,attachment_url,link_url,featured,publish_at,expire_at,published_at").eq("item_type", type).in("status", ["PUBLISHED", "SCHEDULED"]).lte("publish_at", now).or(`expire_at.is.null,expire_at.gt.${now}`).order("featured", { ascending: false }).order("published_at", { ascending: false });
  const slug = String(req.query.slug ?? "").trim();
  if (slug) query = query.eq("slug", slug);
  const result = await query.limit(slug ? 1 : 12);
  if (result.error) throw result.error;
  res.setHeader("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
  res.json({ success: true, data: result.data ?? [] });
}));

router.get("/public/site-page/:slug", handler(async (req, res) => {
  const now = new Date().toISOString();
  const result = await getSupabase().from("idmc_public_site_items").select("slug,title,summary,body,image_url,seo_title,seo_description,search_visible,published_at,publish_at").eq("item_type", "PAGE").eq("slug", String(req.params.slug)).in("status", ["PUBLISHED", "SCHEDULED"]).lte("publish_at", now).or(`expire_at.is.null,expire_at.gt.${now}`).maybeSingle();
  if (result.error) throw result.error;
  if (!result.data) return void fail(res, 404, "Page not found.");
  res.setHeader("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
  res.json({ success: true, data: result.data });
}));

router.get("/public/news", handler(async (req, res) => {
  const pageSize = 12, requestedPage = Number(req.query.page ?? 1), page = Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
  const search = String(req.query.search ?? "").trim().slice(0, 100), now = new Date().toISOString();
  let query = getSupabase().from("idmc_public_site_items").select("id,item_type,slug,title,summary,body,category,image_url,attachment_url,link_url,featured,publish_at,expire_at,published_at", { count: "exact" }).eq("item_type", "NEWS").in("status", ["PUBLISHED", "SCHEDULED"]).lte("publish_at", now).or(`expire_at.is.null,expire_at.gt.${now}`).order("featured", { ascending: false }).order("published_at", { ascending: false });
  query = query.eq("search_visible", true);
  if (search) { const literal = escapeIlikeLiteral(search); query = query.or(`title.ilike.%${literal}%,summary.ilike.%${literal}%,body.ilike.%${literal}%`); }
  const result = await query.range((page - 1) * pageSize, page * pageSize - 1);
  if (result.error) throw result.error;
  res.setHeader("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
  res.json({ success: true, data: { items: result.data ?? [], total: result.count ?? 0, page, pageSize } });
}));

router.get("/public/programmes", handler(async (_req, res) => {
  const result = await getSupabase().from("programmes").select("id,programme_code,programme_name,programme_type,award_level,mode_of_study,duration_years,direct_entry_requirements,specialization,description,departments(department_name)").eq("status", "ACTIVE").order("programme_name").limit(200);
  if (result.error) throw result.error;
  res.setHeader("Cache-Control", "public, max-age=300, stale-while-revalidate=900");
  res.json({ success: true, data: result.data ?? [] });
}));

router.get("/public/statistics", handler(async (_req, res) => {
  const db = getSupabase();
  const [programmes, departments, campuses] = await Promise.all([
    db.from("programmes").select("id", { count: "exact", head: true }).eq("status", "ACTIVE"),
    db.from("departments").select("id", { count: "exact", head: true }).eq("status", "ACTIVE"),
    db.from("campuses").select("id", { count: "exact", head: true }).eq("status", "ACTIVE"),
  ]);
  const errors = [programmes.error, departments.error, campuses.error].filter(Boolean);
  if (errors.length) throw errors[0];
  res.setHeader("Cache-Control", "public, max-age=300, stale-while-revalidate=900");
  res.json({ success: true, data: { source: "IDMS iMIS database", updatedAt: new Date().toISOString(), programmes: programmes.count ?? 0, departments: departments.count ?? 0, campuses: campuses.count ?? 0 } });
}));

router.get("/website/content", authenticate, requirePermission("website.content.manage"), handler(async (_req, res) => {
  const result = await getSupabase().from("idmc_public_site_content").select("content,draft_content,updated_at,published_at,updated_by,published_by").eq("content_key", "homepage").maybeSingle();
  if (result.error) throw result.error;
  res.json({ success: true, data: result.data ?? { content: {}, draft_content: {} } });
}));

router.put("/website/content", authenticate, requirePermission("website.content.manage"), handler(async (req, res) => {
  let content: Record<string, unknown>;
  try { content = validateContent(req.body?.content); }
  catch (error) { fail(res, Number((error as { statusCode?: number })?.statusCode) || 400, error instanceof Error ? error.message : "Invalid website content."); return; }
  const updatedAt = new Date().toISOString();
  const result = await getSupabase().from("idmc_public_site_content").upsert({ content_key: "homepage", draft_content: content, updated_by: req.user!.id, updated_at: updatedAt }, { onConflict: "content_key" }).select("content,draft_content,updated_at,published_at").single();
  if (result.error) throw result.error;
  await createAuditLog({ actorUserId: req.user!.id, actionCode: "PUBLIC_WEBSITE_DRAFT_SAVED", moduleCode: "website", entityType: "website_content", entityId: "homepage", newValues: { fields: Object.keys(content), updatedAt }, ipAddress: req.ip, requestId: req.requestId });
  res.json({ success: true, data: result.data });
}));

router.post("/website/content/publish", authenticate, requirePermission("website.content.manage"), handler(async (req, res) => {
  const db = getSupabase(), current = await db.from("idmc_public_site_content").select("content,draft_content").eq("content_key", "homepage").maybeSingle();
  if (current.error) throw current.error;
  if (!current.data?.draft_content) return void fail(res, 400, "Save a website draft before publishing it.");
  const savedRevision = await db.from("idmc_public_site_revisions").insert({ content_key: "homepage", content: current.data.content ?? {}, change_kind: "PUBLISHED", changed_by: req.user!.id }).select("id").single();
  if (savedRevision.error) throw savedRevision.error;
  const now = new Date().toISOString();
  const result = await db.from("idmc_public_site_content").update({ content: current.data.draft_content, published_at: now, published_by: req.user!.id, updated_by: req.user!.id, updated_at: now }).eq("content_key", "homepage").select("content,draft_content,updated_at,published_at").single();
  if (result.error) throw result.error;
  await createAuditLog({ actorUserId: req.user!.id, actionCode: "PUBLIC_WEBSITE_CONTENT_PUBLISHED", moduleCode: "website", entityType: "website_content", entityId: "homepage", newValues: { publishedAt: now }, ipAddress: req.ip, requestId: req.requestId });
  res.json({ success: true, data: { ...result.data, revisionId: savedRevision.data.id } });
}));

router.get("/website/revisions", authenticate, requirePermission("website.content.manage"), handler(async (_req, res) => {
  const result = await getSupabase().from("idmc_public_site_revisions").select("id,change_kind,changed_at,changed_by").eq("content_key", "homepage").order("changed_at", { ascending: false }).limit(30);
  if (result.error) throw result.error;
  res.json({ success: true, data: result.data ?? [] });
}));

router.post("/website/revisions/:id/restore", authenticate, requirePermission("website.content.manage"), handler(async (req, res) => {
  const db = getSupabase(), revision = await db.from("idmc_public_site_revisions").select("id,content").eq("id", req.params.id).maybeSingle();
  if (revision.error) throw revision.error;
  if (!revision.data) return void fail(res, 404, "Website revision not found.");
  const draft = await db.from("idmc_public_site_content").update({ draft_content: revision.data.content, updated_by: req.user!.id, updated_at: new Date().toISOString() }).eq("content_key", "homepage");
  if (draft.error) throw draft.error;
  await createAuditLog({ actorUserId: req.user!.id, actionCode: "PUBLIC_WEBSITE_REVISION_RESTORED_TO_DRAFT", moduleCode: "website", entityType: "website_content", entityId: String(req.params.id), ipAddress: req.ip, requestId: req.requestId });
  res.json({ success: true, data: { restoredToDraft: true } });
}));

router.get("/website/items", authenticate, requirePermission("website.content.manage"), handler(async (req, res) => {
  const type = String(req.query.type ?? "").toUpperCase();
  const query = getSupabase().from("idmc_public_site_items").select("*").order("updated_at", { ascending: false }).limit(100);
  if (["NEWS", "NOTICE", "PAGE"].includes(type)) query.eq("item_type", type);
  const result = await query;
  if (result.error) throw result.error;
  res.json({ success: true, data: result.data ?? [] });
}));

router.post("/website/items", authenticate, requirePermission("website.content.manage"), handler(async (req, res) => {
  let item: ReturnType<typeof validateEntry>;
  try { item = validateEntry(req.body); }
  catch (error) { fail(res, Number((error as { statusCode?: number })?.statusCode) || 400, error instanceof Error ? error.message : "Invalid content item."); return; }
  const now = new Date().toISOString(), published = item.status === "PUBLISHED";
  const result = await getSupabase().from("idmc_public_site_items").insert({ ...item, publish_at: item.publish_at || (published ? now : null), created_by: req.user!.id, updated_by: req.user!.id, published_by: published ? req.user!.id : null, published_at: published ? now : null, updated_at: now }).select("*").single();
  if (result.error) throw result.error;
  await createAuditLog({ actorUserId: req.user!.id, actionCode: "PUBLIC_SITE_ITEM_CREATED", moduleCode: "website", entityType: "public_site_item", entityId: result.data.id, newValues: { itemType: item.item_type, status: item.status }, ipAddress: req.ip, requestId: req.requestId });
  res.status(201).json({ success: true, data: result.data });
}));

router.put("/website/items/:id", authenticate, requirePermission("website.content.manage"), handler(async (req, res) => {
  let item: ReturnType<typeof validateEntry>;
  try { item = validateEntry(req.body); }
  catch (error) { fail(res, Number((error as { statusCode?: number })?.statusCode) || 400, error instanceof Error ? error.message : "Invalid content item."); return; }
  const now = new Date().toISOString(), published = item.status === "PUBLISHED";
  const result = await getSupabase().from("idmc_public_site_items").update({ ...item, publish_at: item.publish_at || (published ? now : null), updated_by: req.user!.id, published_by: published ? req.user!.id : null, published_at: published ? now : null, updated_at: now }).eq("id", req.params.id).select("*").maybeSingle();
  if (result.error) throw result.error;
  if (!result.data) return void fail(res, 404, "Content item not found.");
  await createAuditLog({ actorUserId: req.user!.id, actionCode: "PUBLIC_SITE_ITEM_UPDATED", moduleCode: "website", entityType: "public_site_item", entityId: result.data.id, newValues: { itemType: item.item_type, status: item.status }, ipAddress: req.ip, requestId: req.requestId });
  res.json({ success: true, data: result.data });
}));

router.delete("/website/items/:id", authenticate, requirePermission("website.content.manage"), handler(async (req, res) => {
  const result = await getSupabase().from("idmc_public_site_items").update({ status: "ARCHIVED", updated_by: req.user!.id, updated_at: new Date().toISOString() }).eq("id", req.params.id).neq("status", "ARCHIVED").select("id").maybeSingle();
  if (result.error) throw result.error;
  if (!result.data) return void fail(res, 404, "Content item not found or already archived.");
  await createAuditLog({ actorUserId: req.user!.id, actionCode: "PUBLIC_SITE_ITEM_ARCHIVED", moduleCode: "website", entityType: "public_site_item", entityId: result.data.id, ipAddress: req.ip, requestId: req.requestId });
  res.json({ success: true, data: { archived: true } });
}));

export default router;
