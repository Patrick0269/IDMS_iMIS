-- Store accountant-published installment metadata with the fee structure and invoice.
ALTER TABLE public.fee_structures
  ADD COLUMN IF NOT EXISTS first_installment_amount numeric(18,2)
  CHECK (first_installment_amount IS NULL OR first_installment_amount >= 0);

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS first_installment_amount numeric(18,2)
  CHECK (first_installment_amount IS NULL OR first_installment_amount >= 0);

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS control_number varchar(100);

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS control_institution_name varchar(255);
