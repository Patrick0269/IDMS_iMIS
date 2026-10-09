BEGIN;

-- Keep payment edits consistent with refund reservations. UPDATE already holds
-- the payment row lock, which is also the lock used by refund inserts/updates.
CREATE OR REPLACE FUNCTION public.validate_payment_refund_capacity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_reserved numeric(18,2);
BEGIN
    IF NEW.student_id IS DISTINCT FROM OLD.student_id
       AND EXISTS (
           SELECT 1 FROM public.refunds WHERE payment_id = OLD.id
       ) THEN
        RAISE EXCEPTION 'Payment student cannot change after a refund is recorded'
            USING ERRCODE = '23514';
    END IF;

    IF NEW.amount IS DISTINCT FROM OLD.amount THEN
        SELECT COALESCE(SUM(amount), 0)
          INTO v_reserved
          FROM public.refunds
         WHERE payment_id = OLD.id
           AND status IN ('REQUESTED', 'APPROVED', 'PROCESSING', 'PAID');

        IF v_reserved > NEW.amount THEN
            RAISE EXCEPTION 'Payment amount cannot be lower than active refund reservations'
                USING ERRCODE = '23514';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_payment_refund_capacity ON public.payments;
CREATE TRIGGER trg_validate_payment_refund_capacity
BEFORE UPDATE OF amount, student_id ON public.payments
FOR EACH ROW
EXECUTE FUNCTION public.validate_payment_refund_capacity();

COMMENT ON FUNCTION public.validate_payment_refund_capacity() IS
    'Prevents payment edits from invalidating active refund capacity or recorded refund ownership.';

COMMIT;
