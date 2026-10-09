BEGIN;
-- Restricted RPCs: the backend passes its authenticated public user ID.
CREATE OR REPLACE FUNCTION public.idmc_receipt_assert_actor(p_actor uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.users u JOIN public.user_roles ur ON ur.user_id=u.id
 JOIN public.roles r ON r.id=ur.role_id JOIN public.role_permissions rp ON rp.role_id=r.id
 JOIN public.permissions p ON p.id=rp.permission_id WHERE u.id=p_actor AND u.status='ACTIVE'
 AND ur.status='ACTIVE' AND r.status='ACTIVE' AND (ur.expires_at IS NULL OR ur.expires_at>now())
 AND p.status='ACTIVE' AND p.permission_code='finance.payments.confirm')
 THEN RAISE EXCEPTION 'Finance payment confirmation permission required' USING ERRCODE='42501'; END IF;
END $$;

CREATE OR REPLACE FUNCTION public.idmc_deduct_confirmed_payment(p_payment uuid,p_invoice uuid,p_actor uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE pay public.payments%ROWTYPE; inv public.invoices%ROWTYPE; available numeric; allocated numeric; deduction numeric; result_id uuid;
BEGIN
 PERFORM public.idmc_receipt_assert_actor(p_actor);
 SELECT * INTO pay FROM public.payments WHERE id=p_payment FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Payment not found'; END IF;
 IF pay.status<>'CONFIRMED' THEN RAISE EXCEPTION 'Only a confirmed payment can be deducted'; END IF;
 SELECT * INTO inv FROM public.invoices WHERE id=p_invoice FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Invoice not found'; END IF;
 IF inv.student_id<>pay.student_id OR inv.currency_code<>pay.currency_code THEN RAISE EXCEPTION 'Payment and invoice must belong to the same student and currency'; END IF;
 IF inv.status IN ('CANCELLED','VOID','DRAFT') THEN RAISE EXCEPTION 'Invoice is not available for payment allocation'; END IF;
 PERFORM public.refresh_invoice_financials(inv.id);
 SELECT * INTO inv FROM public.invoices WHERE id=p_invoice;
 SELECT coalesce(sum(allocated_amount),0) INTO allocated FROM public.payment_allocations WHERE payment_id=pay.id AND status='ACTIVE';
 available:=greatest(0,pay.amount-allocated);
 IF inv.balance_amount<=0 OR available<=0 THEN
  RETURN jsonb_build_object('status','DONE','deducted',0,'invoiceBalance',inv.balance_amount,'availablePayment',available,'alreadyProcessed',true);
 END IF;
 deduction:=least(available,inv.balance_amount);
 INSERT INTO public.payment_allocations(payment_id,invoice_id,allocated_amount,allocation_reference,status,created_by)
 VALUES(pay.id,inv.id,deduction,'ALLOC-'||gen_random_uuid()::text,'ACTIVE',p_actor) RETURNING id INTO result_id;
 PERFORM public.refresh_invoice_financials(inv.id);
 PERFORM public.refresh_student_financial_account(pay.student_id);
 SELECT * INTO inv FROM public.invoices WHERE id=p_invoice;
 RETURN jsonb_build_object('status',CASE WHEN inv.balance_amount<=0 THEN 'DONE' ELSE 'PARTIALLY_PAID' END,'allocationId',result_id,'deducted',deduction,'invoiceBalance',inv.balance_amount,'availablePayment',available-deduction);
END $$;

CREATE OR REPLACE FUNCTION public.idmc_confirm_receipt_payment(p_request uuid,p_reference text,p_notes text,p_actor uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE request public.student_payment_requests%ROWTYPE; inv public.invoices%ROWTYPE; v_payment_id uuid; allocation_result jsonb;
BEGIN
 PERFORM public.idmc_receipt_assert_actor(p_actor);
 SELECT * INTO request FROM public.student_payment_requests WHERE id=p_request FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Payment request not found'; END IF;
 IF request.request_status='CONFIRMED' AND request.payment_id IS NOT NULL THEN
  RETURN jsonb_build_object('status','DONE','paymentId',request.payment_id,'alreadyProcessed',true);
 END IF;
 IF request.request_status<>'RECEIPT_UPLOADED' OR request.receipt_file_path IS NULL THEN RAISE EXCEPTION 'Upload and verify a receipt before confirmation'; END IF;
 IF nullif(trim(p_reference),'') IS NULL THEN RAISE EXCEPTION 'Verified bank or provider reference is required'; END IF;
 SELECT * INTO inv FROM public.invoices WHERE id=request.invoice_id FOR UPDATE;
 IF NOT FOUND OR inv.student_id<>request.student_id THEN RAISE EXCEPTION 'Invoice does not belong to this student'; END IF;
 PERFORM public.refresh_invoice_financials(inv.id);
 SELECT * INTO inv FROM public.invoices WHERE id=request.invoice_id;
 IF inv.balance_amount<=0 THEN RAISE EXCEPTION 'Invoice is already paid. Review this receipt before recording another payment'; END IF;
 IF request.amount<=0 OR request.amount>inv.balance_amount THEN RAISE EXCEPTION 'Receipt amount exceeds the invoice balance or is invalid'; END IF;
 INSERT INTO public.payments(student_id,payment_number,external_reference,control_number,payment_method,provider,amount,currency_code,status,confirmed_by,confirmed_at,created_by,updated_by)
 VALUES(request.student_id,'PAY-'||gen_random_uuid()::text,trim(p_reference),request.control_number,'CONTROL_NUMBER','IDMC_CONTROL_NUMBER',request.amount,inv.currency_code,'CONFIRMED',p_actor,now(),p_actor,p_actor) RETURNING id INTO v_payment_id;
 allocation_result:=public.idmc_deduct_confirmed_payment(v_payment_id,inv.id,p_actor);
 UPDATE public.student_payment_requests SET request_status='CONFIRMED',payment_id=v_payment_id,reviewed_by=p_actor,reviewed_at=now(),finance_notes=left(p_notes,2000),paid_at=now(),provider_message='Payment verified and deducted from invoice.',updated_at=now() WHERE id=p_request;
 INSERT INTO public.finance_workflow_history(entity_type,entity_id,action,previous_status,new_status,performed_by,comment)
 VALUES('PAYMENT_REQUEST',p_request,'CONFIRM_PAYMENT','RECEIPT_UPLOADED','CONFIRMED',p_actor,left(p_notes,2000));
 RETURN allocation_result||jsonb_build_object('paymentId',v_payment_id,'requestId',p_request);
END $$;
REVOKE ALL ON FUNCTION public.idmc_receipt_assert_actor(uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.idmc_deduct_confirmed_payment(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.idmc_confirm_receipt_payment(uuid,text,text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.idmc_deduct_confirmed_payment(uuid,uuid,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.idmc_confirm_receipt_payment(uuid,text,text,uuid) TO service_role;
COMMIT;
