-- Enforce one active reservation per member and library item under concurrency.
BEGIN;

DO $$
DECLARE
  v_duplicate_groups integer;
BEGIN
  SELECT count(*)::integer INTO v_duplicate_groups
    FROM (
      SELECT library_member_id, library_item_id
        FROM public.library_reservations
       WHERE reservation_status = 'ACTIVE'
       GROUP BY library_member_id, library_item_id
      HAVING count(*) > 1
    ) duplicates;

  IF v_duplicate_groups > 0 THEN
    RAISE EXCEPTION 'Cannot enforce active library reservation uniqueness: % duplicate member/item pairs need manual review.', v_duplicate_groups
      USING ERRCODE = '23505';
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_library_reservations_active_member_item
  ON public.library_reservations (library_member_id, library_item_id)
  WHERE reservation_status = 'ACTIVE';

COMMIT;
