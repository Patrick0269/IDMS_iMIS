BEGIN;

-- Serialize refund reservations on the payment row. This makes the database
-- authoritative when two requests arrive before either transaction commits.
CREATE OR REPLACE FUNCTION public.validate_refund_integrity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_payment_amount numeric(18,2);
    v_payment_student_id uuid;
    v_reserved numeric(18,2);
BEGIN
    IF TG_OP = 'UPDATE' AND NEW.payment_id IS DISTINCT FROM OLD.payment_id THEN
        RAISE EXCEPTION 'Refund payment cannot be changed'
            USING ERRCODE = '23514';
    END IF;

    SELECT amount, student_id
      INTO v_payment_amount, v_payment_student_id
      FROM public.payments
     WHERE id = NEW.payment_id
       FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Refund payment does not exist'
            USING ERRCODE = '23503';
    END IF;

    IF NEW.student_id IS DISTINCT FROM v_payment_student_id THEN
        RAISE EXCEPTION 'Refund student does not own this payment'
            USING ERRCODE = '23514';
    END IF;

    IF NEW.status IN ('REQUESTED', 'APPROVED', 'PROCESSING', 'PAID') THEN
        SELECT COALESCE(SUM(amount), 0)
          INTO v_reserved
          FROM public.refunds
         WHERE payment_id = NEW.payment_id
           AND status IN ('REQUESTED', 'APPROVED', 'PROCESSING', 'PAID')
           AND id <> NEW.id;

        IF v_reserved + NEW.amount > v_payment_amount THEN
            RAISE EXCEPTION 'Total active refund reservations cannot exceed payment amount'
                USING ERRCODE = '23514';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_refund_integrity ON public.refunds;
CREATE TRIGGER trg_validate_refund_integrity
BEFORE INSERT OR UPDATE ON public.refunds
FOR EACH ROW
EXECUTE FUNCTION public.validate_refund_integrity();

COMMENT ON FUNCTION public.validate_refund_integrity() IS
    'Locks each payment while reserving requested, approved, processing, or paid refunds; prevents concurrent over-refunding.';

COMMIT;
