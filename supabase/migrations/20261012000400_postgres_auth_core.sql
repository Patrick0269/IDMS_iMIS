BEGIN;

-- Local PostgreSQL Auth core. This preserves existing auth.users identities
-- and password hashes while moving session validation/refresh off GoTrue.
CREATE TABLE IF NOT EXISTS public.idmc_auth_refresh_tokens (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  auth_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idmc_auth_refresh_tokens_user_expiry_idx
  ON public.idmc_auth_refresh_tokens (auth_user_id, expires_at DESC);

CREATE TABLE IF NOT EXISTS public.idmc_auth_action_tokens (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  auth_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  action_type text NOT NULL CHECK (action_type IN ('signup', 'magiclink', 'recovery')),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idmc_auth_action_tokens_user_expiry_idx
  ON public.idmc_auth_action_tokens (auth_user_id, action_type, expires_at DESC);

ALTER TABLE public.idmc_auth_refresh_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.idmc_auth_action_tokens ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.idmc_auth_refresh_tokens FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.idmc_auth_action_tokens FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE IF NOT EXISTS public.idmc_storage_objects (
  bucket_id text NOT NULL,
  object_path text NOT NULL,
  contents bytea NOT NULL,
  content_type text NOT NULL DEFAULT 'application/octet-stream',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(bucket_id, object_path),
  CHECK (octet_length(contents) <= 20971520)
);
ALTER TABLE public.idmc_storage_objects ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.idmc_storage_objects FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.idmc_local_auth_user_by_id(p_user_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, auth
AS $function$
  SELECT jsonb_build_object(
    'id', u.id,
    'email', u.email,
    'encrypted_password', u.encrypted_password,
    'email_confirmed_at', u.email_confirmed_at,
    'raw_app_meta_data', COALESCE(u.raw_app_meta_data, '{}'::jsonb),
    'raw_user_meta_data', COALESCE(u.raw_user_meta_data, '{}'::jsonb),
    'banned_until', u.banned_until,
    'deleted_at', u.deleted_at
  )
  FROM auth.users AS u
  WHERE u.id = p_user_id
    AND u.deleted_at IS NULL
  LIMIT 1;
$function$;

CREATE OR REPLACE FUNCTION public.idmc_local_auth_user_by_email(p_email text)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, auth
AS $function$
  SELECT jsonb_build_object(
    'id', u.id,
    'email', u.email,
    'encrypted_password', u.encrypted_password,
    'email_confirmed_at', u.email_confirmed_at,
    'raw_app_meta_data', COALESCE(u.raw_app_meta_data, '{}'::jsonb),
    'raw_user_meta_data', COALESCE(u.raw_user_meta_data, '{}'::jsonb),
    'banned_until', u.banned_until,
    'deleted_at', u.deleted_at
  )
  FROM auth.users AS u
  WHERE lower(u.email) = lower(btrim(p_email))
    AND u.deleted_at IS NULL
  ORDER BY u.created_at, u.id
  LIMIT 1;
$function$;

CREATE OR REPLACE FUNCTION public.idmc_local_auth_touch_login(p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth
AS $function$
BEGIN
  UPDATE auth.users SET last_sign_in_at = now(), updated_at = now()
  WHERE id = p_user_id AND deleted_at IS NULL;
  RETURN FOUND;
END;
$function$;

CREATE OR REPLACE FUNCTION public.idmc_local_auth_create_user(
  p_user_id uuid,
  p_email text,
  p_password_hash text,
  p_email_confirmed boolean,
  p_user_meta jsonb DEFAULT '{}'::jsonb,
  p_app_meta jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth
AS $function$
DECLARE v_user auth.users%ROWTYPE;
BEGIN
  IF p_user_id IS NULL OR p_email IS NULL OR lower(btrim(p_email)) !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     OR p_password_hash !~ '^\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}$' THEN
    RAISE EXCEPTION 'Invalid local Auth user parameters' USING ERRCODE = '22023';
  END IF;

  INSERT INTO auth.users(
    id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at
  ) VALUES (
    p_user_id, 'authenticated', 'authenticated', lower(btrim(p_email)), p_password_hash,
    CASE WHEN p_email_confirmed THEN now() ELSE NULL END,
    COALESCE(p_app_meta, '{}'::jsonb), COALESCE(p_user_meta, '{}'::jsonb), now(), now()
  ) RETURNING * INTO v_user;

  RETURN jsonb_build_object(
    'id', v_user.id, 'email', v_user.email, 'encrypted_password', v_user.encrypted_password,
    'email_confirmed_at', v_user.email_confirmed_at,
    'raw_app_meta_data', COALESCE(v_user.raw_app_meta_data, '{}'::jsonb),
    'raw_user_meta_data', COALESCE(v_user.raw_user_meta_data, '{}'::jsonb),
    'banned_until', v_user.banned_until, 'deleted_at', v_user.deleted_at
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.idmc_local_auth_update_credentials(
  p_user_id uuid,
  p_password_hash text DEFAULT NULL,
  p_app_meta jsonb DEFAULT NULL,
  p_email_confirmed boolean DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth
AS $function$
DECLARE v_user auth.users%ROWTYPE;
BEGIN
  IF p_password_hash IS NOT NULL AND p_password_hash !~ '^\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}$' THEN
    RAISE EXCEPTION 'Invalid password hash' USING ERRCODE = '22023';
  END IF;
  UPDATE auth.users AS u
     SET encrypted_password = COALESCE(p_password_hash, u.encrypted_password),
         raw_app_meta_data = COALESCE(p_app_meta, u.raw_app_meta_data, '{}'::jsonb),
         email_confirmed_at = CASE
           WHEN p_email_confirmed IS TRUE THEN COALESCE(u.email_confirmed_at, now())
           WHEN p_email_confirmed IS FALSE THEN NULL
           ELSE u.email_confirmed_at
         END,
         updated_at = now()
   WHERE u.id = p_user_id AND u.deleted_at IS NULL
  RETURNING u.* INTO v_user;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF p_password_hash IS NOT NULL THEN
    UPDATE public.idmc_auth_refresh_tokens SET consumed_at = COALESCE(consumed_at, now())
    WHERE auth_user_id = p_user_id AND consumed_at IS NULL;
  END IF;
  RETURN jsonb_build_object(
    'id', v_user.id, 'email', v_user.email, 'encrypted_password', v_user.encrypted_password,
    'email_confirmed_at', v_user.email_confirmed_at,
    'raw_app_meta_data', COALESCE(v_user.raw_app_meta_data, '{}'::jsonb),
    'raw_user_meta_data', COALESCE(v_user.raw_user_meta_data, '{}'::jsonb),
    'banned_until', v_user.banned_until, 'deleted_at', v_user.deleted_at
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.idmc_local_auth_delete_user(p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth
AS $function$
BEGIN
  DELETE FROM auth.users WHERE id = p_user_id;
  RETURN FOUND;
END;
$function$;

CREATE OR REPLACE FUNCTION public.idmc_local_auth_update_profile(
  p_user_id uuid, p_email text DEFAULT NULL, p_password_hash text DEFAULT NULL,
  p_app_meta jsonb DEFAULT NULL, p_user_meta jsonb DEFAULT NULL, p_email_confirmed boolean DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth
AS $function$
DECLARE v_user auth.users%ROWTYPE;
BEGIN
  IF p_email IS NOT NULL AND lower(btrim(p_email)) !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' THEN
    RAISE EXCEPTION 'Invalid email address' USING ERRCODE = '22023';
  END IF;
  IF p_password_hash IS NOT NULL AND p_password_hash !~ '^\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}$' THEN
    RAISE EXCEPTION 'Invalid password hash' USING ERRCODE = '22023';
  END IF;
  UPDATE auth.users AS u
     SET email = COALESCE(lower(btrim(p_email)), u.email),
         encrypted_password = COALESCE(p_password_hash, u.encrypted_password),
         raw_app_meta_data = COALESCE(p_app_meta, u.raw_app_meta_data, '{}'::jsonb),
         raw_user_meta_data = COALESCE(p_user_meta, u.raw_user_meta_data, '{}'::jsonb),
         email_confirmed_at = CASE WHEN p_email_confirmed IS TRUE THEN COALESCE(u.email_confirmed_at, now()) WHEN p_email_confirmed IS FALSE THEN NULL ELSE u.email_confirmed_at END,
         updated_at = now()
   WHERE u.id = p_user_id AND u.deleted_at IS NULL
  RETURNING u.* INTO v_user;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF p_password_hash IS NOT NULL THEN
    UPDATE public.idmc_auth_refresh_tokens SET consumed_at = COALESCE(consumed_at, now())
    WHERE auth_user_id = p_user_id AND consumed_at IS NULL;
  END IF;
  RETURN jsonb_build_object('id', v_user.id, 'email', v_user.email, 'encrypted_password', v_user.encrypted_password,
    'email_confirmed_at', v_user.email_confirmed_at, 'raw_app_meta_data', COALESCE(v_user.raw_app_meta_data, '{}'::jsonb),
    'raw_user_meta_data', COALESCE(v_user.raw_user_meta_data, '{}'::jsonb), 'banned_until', v_user.banned_until, 'deleted_at', v_user.deleted_at);
END;
$function$;

CREATE OR REPLACE FUNCTION public.idmc_local_auth_list_users(p_page integer DEFAULT 1, p_per_page integer DEFAULT 1000)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, auth
AS $function$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', u.id, 'email', u.email, 'encrypted_password', u.encrypted_password,
    'email_confirmed_at', u.email_confirmed_at, 'raw_app_meta_data', COALESCE(u.raw_app_meta_data, '{}'::jsonb),
    'raw_user_meta_data', COALESCE(u.raw_user_meta_data, '{}'::jsonb), 'banned_until', u.banned_until, 'deleted_at', u.deleted_at)
    ORDER BY u.created_at, u.id), '[]'::jsonb)
  FROM (SELECT * FROM auth.users ORDER BY created_at, id LIMIT LEAST(GREATEST(p_per_page, 1), 1000) OFFSET (GREATEST(p_page, 1) - 1) * LEAST(GREATEST(p_per_page, 1), 1000)) AS u;
$function$;

CREATE OR REPLACE FUNCTION public.idmc_local_storage_put(p_bucket text, p_path text, p_contents_base64 text, p_content_type text DEFAULT 'application/octet-stream', p_upsert boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE v_bytes bytea; v_path text;
BEGIN
  IF p_bucket !~ '^[a-z0-9][a-z0-9._-]{0,99}$' OR p_path IS NULL OR p_path = '' OR p_path LIKE '/%' OR p_path ~ '(^|/)\.\.?(/|$)' THEN
    RAISE EXCEPTION 'Invalid storage path' USING ERRCODE = '22023';
  END IF;
  v_bytes := decode(p_contents_base64, 'base64');
  IF octet_length(v_bytes) > 20971520 THEN RAISE EXCEPTION 'File exceeds 20 MiB' USING ERRCODE = '22023'; END IF;
  INSERT INTO public.idmc_storage_objects(bucket_id, object_path, contents, content_type)
  VALUES (p_bucket, p_path, v_bytes, COALESCE(NULLIF(p_content_type, ''), 'application/octet-stream'))
  ON CONFLICT (bucket_id, object_path) DO UPDATE
    SET contents = EXCLUDED.contents, content_type = EXCLUDED.content_type, updated_at = now()
    WHERE p_upsert
  RETURNING object_path INTO v_path;
  IF NOT FOUND THEN RAISE EXCEPTION 'File already exists' USING ERRCODE = '23505'; END IF;
  RETURN jsonb_build_object('path', p_path, 'fullPath', p_bucket || '/' || p_path);
END;
$function$;

CREATE OR REPLACE FUNCTION public.idmc_local_storage_remove(p_bucket text, p_paths text[])
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE v_removed jsonb;
BEGIN
  WITH removed AS (
    DELETE FROM public.idmc_storage_objects WHERE bucket_id = p_bucket AND object_path = ANY(COALESCE(p_paths, ARRAY[]::text[]))
    RETURNING object_path
  ) SELECT COALESCE(jsonb_agg(object_path), '[]'::jsonb) INTO v_removed FROM removed;
  RETURN v_removed;
END;
$function$;

CREATE OR REPLACE FUNCTION public.idmc_local_storage_download(p_bucket text, p_path text)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT jsonb_build_object('path', o.object_path, 'content_type', o.content_type, 'contents_base64', encode(o.contents, 'base64'), 'size', octet_length(o.contents))
  FROM public.idmc_storage_objects AS o WHERE o.bucket_id = p_bucket AND o.object_path = p_path;
$function$;

CREATE OR REPLACE FUNCTION public.idmc_local_auth_issue_action(
  p_user_id uuid, p_token_hash text, p_action_type text, p_expires_at timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth
AS $function$
BEGIN
  IF p_token_hash !~ '^[0-9a-f]{64}$'
     OR p_action_type NOT IN ('signup', 'magiclink', 'recovery')
     OR p_expires_at <= now() OR p_expires_at > now() + interval '2 days' THEN
    RAISE EXCEPTION 'Invalid Auth action-token parameters' USING ERRCODE = '22023';
  END IF;
  UPDATE public.idmc_auth_action_tokens
     SET consumed_at = COALESCE(consumed_at, now())
   WHERE auth_user_id = p_user_id AND action_type = p_action_type AND consumed_at IS NULL;
  INSERT INTO public.idmc_auth_action_tokens(token_hash, auth_user_id, action_type, expires_at)
  SELECT p_token_hash, u.id, p_action_type, p_expires_at
  FROM auth.users AS u WHERE u.id = p_user_id AND u.deleted_at IS NULL;
  RETURN FOUND;
END;
$function$;

CREATE OR REPLACE FUNCTION public.idmc_local_auth_consume_action(p_token_hash text, p_action_type text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth
AS $function$
DECLARE v_user auth.users%ROWTYPE;
BEGIN
  IF p_token_hash !~ '^[0-9a-f]{64}$' OR p_action_type NOT IN ('signup', 'magiclink', 'recovery') THEN RETURN NULL; END IF;
  UPDATE public.idmc_auth_action_tokens AS t SET consumed_at = now()
   WHERE t.token_hash = p_token_hash AND t.action_type = p_action_type
     AND t.consumed_at IS NULL AND t.expires_at > now()
     AND EXISTS (SELECT 1 FROM auth.users AS u WHERE u.id = t.auth_user_id AND u.deleted_at IS NULL);
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT u.* INTO v_user FROM auth.users AS u
   JOIN public.idmc_auth_action_tokens AS t ON t.auth_user_id = u.id
   WHERE t.token_hash = p_token_hash;
  IF p_action_type IN ('signup', 'magiclink') THEN
    UPDATE auth.users SET email_confirmed_at = COALESCE(email_confirmed_at, now()), updated_at = now()
     WHERE id = v_user.id RETURNING * INTO v_user;
  END IF;
  RETURN jsonb_build_object(
    'id', v_user.id, 'email', v_user.email, 'encrypted_password', v_user.encrypted_password,
    'email_confirmed_at', v_user.email_confirmed_at,
    'raw_app_meta_data', COALESCE(v_user.raw_app_meta_data, '{}'::jsonb),
    'raw_user_meta_data', COALESCE(v_user.raw_user_meta_data, '{}'::jsonb),
    'banned_until', v_user.banned_until, 'deleted_at', v_user.deleted_at
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.idmc_local_auth_issue_refresh(
  p_user_id uuid,
  p_token_hash text,
  p_expires_at timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth
AS $function$
BEGIN
  IF p_token_hash !~ '^[0-9a-f]{64}$' OR p_expires_at <= now() OR p_expires_at > now() + interval '32 days' THEN
    RAISE EXCEPTION 'Invalid refresh-token parameters' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.idmc_auth_refresh_tokens(token_hash, auth_user_id, expires_at)
  SELECT p_token_hash, u.id, p_expires_at
  FROM auth.users AS u
  WHERE u.id = p_user_id AND u.deleted_at IS NULL;
  RETURN FOUND;
END;
$function$;

CREATE OR REPLACE FUNCTION public.idmc_local_auth_consume_refresh(p_token_hash text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth
AS $function$
DECLARE v_user_id uuid;
BEGIN
  IF p_token_hash !~ '^[0-9a-f]{64}$' THEN RETURN NULL; END IF;
  UPDATE public.idmc_auth_refresh_tokens AS t
     SET consumed_at = now()
   WHERE t.token_hash = p_token_hash
     AND t.consumed_at IS NULL
     AND t.expires_at > now()
     AND EXISTS (SELECT 1 FROM auth.users AS u WHERE u.id = t.auth_user_id AND u.deleted_at IS NULL)
  RETURNING t.auth_user_id INTO v_user_id;
  RETURN v_user_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.idmc_local_auth_revoke_refresh(p_token_hash text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth
AS $function$
BEGIN
  IF p_token_hash !~ '^[0-9a-f]{64}$' THEN RETURN false; END IF;
  UPDATE public.idmc_auth_refresh_tokens SET consumed_at = COALESCE(consumed_at, now())
  WHERE token_hash = p_token_hash;
  RETURN FOUND;
END;
$function$;

REVOKE ALL ON FUNCTION public.idmc_local_auth_user_by_id(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.idmc_local_auth_user_by_email(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.idmc_local_auth_touch_login(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.idmc_local_auth_create_user(uuid, text, text, boolean, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.idmc_local_auth_update_credentials(uuid, text, jsonb, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.idmc_local_auth_delete_user(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.idmc_local_auth_update_profile(uuid, text, text, jsonb, jsonb, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.idmc_local_auth_list_users(integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.idmc_local_storage_put(text, text, text, text, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.idmc_local_storage_remove(text, text[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.idmc_local_storage_download(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.idmc_local_auth_issue_action(uuid, text, text, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.idmc_local_auth_consume_action(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.idmc_local_auth_issue_refresh(uuid, text, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.idmc_local_auth_consume_refresh(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.idmc_local_auth_revoke_refresh(text) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.idmc_local_auth_user_by_id(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.idmc_local_auth_user_by_email(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.idmc_local_auth_touch_login(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.idmc_local_auth_create_user(uuid, text, text, boolean, jsonb, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.idmc_local_auth_update_credentials(uuid, text, jsonb, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.idmc_local_auth_delete_user(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.idmc_local_auth_update_profile(uuid, text, text, jsonb, jsonb, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.idmc_local_auth_list_users(integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.idmc_local_storage_put(text, text, text, text, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.idmc_local_storage_remove(text, text[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.idmc_local_storage_download(text, text) TO service_role;

COMMIT;
GRANT EXECUTE ON FUNCTION public.idmc_local_auth_issue_action(uuid, text, text, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.idmc_local_auth_consume_action(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.idmc_local_auth_issue_refresh(uuid, text, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.idmc_local_auth_consume_refresh(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.idmc_local_auth_revoke_refresh(text) TO service_role;
