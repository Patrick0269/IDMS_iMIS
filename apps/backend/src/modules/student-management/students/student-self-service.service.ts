import { randomUUID } from "node:crypto";
import type { Request } from "express";
import { institutionDb } from "../../institution-management/shared/institution-db.js";
import { getMyStudentRecord } from "./students.service.js";
import { changeAuthenticatedPassword } from "../../../services/password.service.js";
import { StudentSelfServiceError } from "./student-self-service.errors.js";

type Row = Record<string, any>;
const PORTAL_DATA_WARNING = "Some portal information could not be loaded. Refresh or contact Registry if this continues.";

function clean(value: unknown, max = 2000): string | null {
    const text = String(value ?? "").trim();
    return text ? text.slice(0, max) : null;
}

function publicUserId(req: Request): string {
    if (!req.user?.id) throw new Error("Authenticated IDMC user identity is unavailable.");
    return String(req.user.id);
}

function authUserId(req: Request): string {
    const value = req.user?.authUserId ?? req.authUser?.id;
    if (!value) throw new Error("Authenticated account identity is unavailable.");
    return String(value);
}

async function ownStudent(req: Request): Promise<Row> {
    return await getMyStudentRecord(req) as Row;
}

export async function getStudentPortal(req: Request) {
    const base = await ownStudent(req);
    const studentId = String(base.id);
    const warnings: string[] = [];

    async function rows(table: string, column: string, value: string | null | undefined, order?: string): Promise<Row[]> {
        if (!value) return [];
        let query: any = institutionDb.from(table).select("*").eq(column, value);
        if (order) query = query.order(order, { ascending: false });
        const result = await query.limit(500);
        if (result.error) {
            warnings.push(PORTAL_DATA_WARNING);
            return [];
        }
        return result.data ?? [];
    }

    async function one(table: string, column: string, value: string | null | undefined): Promise<Row | null> {
        if (!value) return null;
        const result = await institutionDb.from(table).select("*").eq(column, value).maybeSingle();
        if (result.error) {
            warnings.push(PORTAL_DATA_WARNING);
            return null;
        }
        return result.data ?? null;
    }

    async function byIds(table: string, ids: unknown[]): Promise<Row[]> {
        const values = [...new Set(ids.filter(Boolean).map(String))];
        if (!values.length) return [];
        const result = await institutionDb.from(table).select("*").in("id", values);
        if (result.error) {
            warnings.push(PORTAL_DATA_WARNING);
            return [];
        }
        return result.data ?? [];
    }

    const [
        applicant, profile, programme, application, admissionDocuments,
        registrations, courseRegistrations, attendance, courseResults,
        semesterResults, cgpaRecords, courseAttempts, deficiencies,
        invoices, payments, transactions, account,
        emergencyContacts, guardians, studentDocuments, qualifications,
        requests, evaluations, courseworkResponses, notifications,
        helpdeskTickets, securityLogs, hostelAllocations,
        clinicalPlacements, fieldPracticals, scholarships,
        libraryMember, graduationCandidates,
    ] = await Promise.all([
        one("applicants", "id", base.applicant_id),
        one("student_profiles", "student_id", studentId),
        one("programmes", "id", base.programme_id),
        one("applications", "id", base.source_application_id),
        rows("application_documents", "application_id", base.source_application_id, "uploaded_at"),
        rows("student_registrations", "student_id", studentId, "created_at"),
        rows("course_registrations", "student_id", studentId, "created_at"),
        rows("attendance_records", "student_id", studentId, "created_at"),
        rows("course_results", "student_id", studentId, "created_at"),
        rows("student_semester_results", "student_id", studentId, "created_at"),
        rows("student_cgpa_records", "student_id", studentId, "calculated_at"),
        rows("student_course_attempts", "student_id", studentId, "created_at"),
        rows("student_academic_deficiencies", "student_id", studentId, "created_at"),
        rows("invoices", "student_id", studentId, "invoice_date"),
        rows("payments", "student_id", studentId, "payment_date"),
        rows("financial_transactions", "student_id", studentId, "transaction_date"),
        one("student_financial_accounts", "student_id", studentId),
        rows("emergency_contacts", "student_id", studentId, "created_at"),
        rows("guardians", "student_id", studentId, "created_at"),
        rows("student_documents", "student_id", studentId, "uploaded_at"),
        rows("academic_qualifications", "applicant_id", base.applicant_id, "created_at"),
        rows("student_service_requests", "student_id", studentId, "submitted_at"),
        rows("student_course_evaluations", "student_id", studentId, "submitted_at"),
        rows("student_coursework_responses", "student_id", studentId, "responded_at"),
        rows("notifications", "recipient_student_id", studentId, "created_at"),
        rows("helpdesk_tickets", "requester_student_id", studentId, "created_at"),
        rows("security_logs", "user_id", base.user_id, "created_at"),
        rows("hostel_allocations", "student_id", studentId, "created_at"),
        rows("clinical_placements", "student_id", studentId, "start_date"),
        rows("field_practicals", "student_id", studentId, "start_date"),
        rows("student_scholarships", "student_id", studentId, "created_at"),
        one("library_members", "student_id", studentId),
        rows("graduation_candidates", "student_id", studentId, "created_at"),
    ]);

    const [applicationChoices, applicationKin, applicationYear, currentYearResult, userLogin] = await Promise.all([
        rows("application_choices", "application_id", base.source_application_id),
        one("application_next_of_kin", "application_id", base.source_application_id),
        one("academic_years", "id", application?.academic_year_id),
        institutionDb.from("academic_years").select("id,year_name,year_code,start_date").in("status", ["ACTIVE", "OPEN"]).order("start_date", { ascending: false }).limit(1).maybeSingle(),
        base.user_id ? institutionDb.from("users").select("last_login_at").eq("id", base.user_id).maybeSingle() : Promise.resolve({ data: null, error: null }),
    ]);
    if (currentYearResult.error) warnings.push(PORTAL_DATA_WARNING);
    if (userLogin.error) warnings.push(PORTAL_DATA_WARNING);
    const choiceProgrammes = await byIds("programmes", applicationChoices.map(item => item.programme_id));

    const firstName = base.first_name || profile?.first_name || applicant?.first_name || null;
    const middleName = base.middle_name || profile?.middle_name || applicant?.middle_name || null;
    const lastName = base.last_name || profile?.last_name || applicant?.last_name || null;
    const selectedPhoto = studentDocuments.find(item => String(item.document_type).toUpperCase() === "PROFILE_PHOTO")?.file_url;
    const admissionPhoto = admissionDocuments.find(item => String(item.document_type).toUpperCase() === "PROFILE_PHOTO")?.file_url;
    const student = {
        ...base,
        first_name: firstName,
        middle_name: middleName,
        last_name: lastName,
        full_name: [firstName, middleName, lastName].filter(Boolean).join(" ") || base.student_number,
        gender: base.gender || profile?.gender || applicant?.gender || null,
        date_of_birth: base.date_of_birth || profile?.date_of_birth || applicant?.date_of_birth || null,
        nationality: base.nationality || profile?.nationality || applicant?.nationality || null,
        national_id: base.national_id || profile?.national_id_number || applicant?.national_id_number || null,
        passport_number: base.passport_number || profile?.passport_number || applicant?.passport_number || null,
        phone: base.phone || profile?.phone || applicant?.phone || null,
        alternate_phone: profile?.alternate_phone || null,
        email: base.email || profile?.email || applicant?.email || null,
        physical_address: base.physical_address || [applicant?.address_line_1, applicant?.address_line_2, applicant?.city, applicant?.district, applicant?.region, applicant?.country].filter(Boolean).join(", ") || null,
        marital_status: profile?.marital_status || null,
        disability_status: profile?.disability_status || null,
        blood_group: profile?.blood_group || null,
        profile_photo_url: base.profile_photo_url || profile?.profile_photo_url || applicant?.profile_photo_url || selectedPhoto || admissionPhoto || null,
        applicant_number: applicant?.applicant_number || null,
        application_number: application?.application_number || null,
        application_status: application?.status || null,
        academic_year_id: application?.academic_year_id || registrations[0]?.academic_year_id || null,
        programme_code: programme?.programme_code || null,
        programme_name: programme?.programme_name || null,
        programme_type: programme?.programme_type || null,
        award_level: programme?.award_level || null,
        duration_years: programme?.duration_years || null,
        mode_of_study: programme?.mode_of_study || null,
        department_id: programme?.department_id || null,
        school_id: programme?.school_id || null,
    };

    const [department, school] = await Promise.all([
        one("departments", "id", student.department_id),
        one("schools", "id", student.school_id),
    ]);
    const campus = await one("campuses", "id", school?.campus_id);

    const offeringIds = courseRegistrations.map(item => item.course_offering_id);
    const offerings = await byIds("course_offerings", offeringIds);
    const courseIds = [...courseRegistrations.map(item => item.course_id), ...offerings.map(item => item.course_id), ...deficiencies.map(item => item.course_id), ...courseAttempts.map(item => item.course_id), ...clinicalPlacements.map(item => item.course_id), ...fieldPracticals.map(item => item.course_id)];
    const courseMaster = await byIds("courses", courseIds);
    const offeringMap = new Map(offerings.map(item => [item.id, item]));
    const courseMap = new Map(courseMaster.map(item => [item.id, item]));

    const [assessmentsResult, submissionsResult, libraryLoans, libraryReservations, libraryFines] = await Promise.all([
        offeringIds.filter(Boolean).length ? institutionDb.from("assessments").select("*").in("course_offering_id", [...new Set(offeringIds.filter(Boolean))]).order("due_date") : { data: [], error: null },
        rows("assessment_submissions", "student_id", studentId, "submitted_at"),
        libraryMember ? rows("library_loans", "library_member_id", libraryMember.id, "loan_date") : Promise.resolve([]),
        libraryMember ? rows("library_reservations", "library_member_id", libraryMember.id, "reservation_date") : Promise.resolve([]),
        libraryMember ? rows("library_fines", "member_id", libraryMember.id, "created_at") : Promise.resolve([]),
    ]);
    if (assessmentsResult.error) warnings.push(PORTAL_DATA_WARNING);
    const enrichCourse = (item: Row) => {
        const offering = offeringMap.get(item.course_offering_id) ?? {};
        const course = courseMap.get(item.course_id || offering.course_id) ?? {};
        return { ...item, offering_code: offering.offering_code ?? null, course_code: course.course_code ?? null, course_name: course.course_name ?? null, credit_units: item.credits ?? item.credit_units ?? course.credit_units ?? null };
    };

    const timetableResult = offeringIds.filter(Boolean).length
        ? await institutionDb.from("timetable_entries").select("*").in("course_offering_id", [...new Set(offeringIds.filter(Boolean))])
        : { data: [], error: null };
    if (timetableResult.error) warnings.push(PORTAL_DATA_WARNING);
    const timetableEntries = timetableResult.data ?? [];
    const [slots, roomsData, classesData, lecturerAssignments] = await Promise.all([
        byIds("timetable_slots", timetableEntries.map(item => item.timetable_slot_id)),
        byIds("rooms", timetableEntries.map(item => item.room_id)),
        byIds("classes", timetableEntries.map(item => item.class_id)),
        byIds("lecturer_assignments", timetableEntries.map(item => item.lecturer_assignment_id)),
    ]);
    const lecturerUsers = await byIds("users", lecturerAssignments.map(item => item.lecturer_user_id));
    const slotMap = new Map(slots.map(item => [item.id, item]));
    const roomMap = new Map(roomsData.map(item => [item.id, item]));
    const classMap = new Map(classesData.map(item => [item.id, item]));
    const assignmentMap = new Map(lecturerAssignments.map(item => [item.id, item]));
    const userMap = new Map(lecturerUsers.map(item => [item.id, item]));
    const timetable = timetableEntries.map(item => {
        const course = enrichCourse(item);
        const assignment = assignmentMap.get(item.lecturer_assignment_id) ?? {};
        const lecturer = userMap.get(assignment.lecturer_user_id) ?? {};
        return { ...course, slot: slotMap.get(item.timetable_slot_id) ?? null, room: roomMap.get(item.room_id) ?? null, class_record: classMap.get(item.class_id) ?? null, lecturer_name: lecturer.display_name || [lecturer.first_name, lecturer.last_name].filter(Boolean).join(" ") || null };
    });

    const candidates = await rows("examination_candidates", "student_id", studentId, "created_at");
    const papers = await byIds("examination_papers", candidates.map(item => item.examination_paper_id));
    const assignments = candidates.length ? await institutionDb.from("examination_candidate_sessions").select("*").in("examination_candidate_id", candidates.map(item => item.id)) : { data: [], error: null };
    if (assignments.error) warnings.push(PORTAL_DATA_WARNING);
    const examAssignments = assignments.data ?? [];
    const sessions = await byIds("examination_sessions", examAssignments.map(item => item.examination_session_id));
    const examRooms = await byIds("rooms", sessions.map(item => item.room_id));
    const candidateMap = new Map(candidates.map(item => [item.id, item]));
    const paperMap = new Map(papers.map(item => [item.id, item]));
    const sessionMap = new Map(sessions.map(item => [item.id, item]));
    const examRoomMap = new Map(examRooms.map(item => [item.id, item]));
    const examinationTimetable = examAssignments.map(item => {
        const candidate = candidateMap.get(item.examination_candidate_id) ?? {};
        const paper = paperMap.get(candidate.examination_paper_id) ?? {};
        const session = sessionMap.get(item.examination_session_id) ?? {};
        const offering = offeringMap.get(paper.course_offering_id) ?? {};
        const course = courseMap.get(offering.course_id) ?? {};
        return { ...item, candidate_number: candidate.candidate_number, eligibility_status: candidate.eligibility_status, paper_code: paper.paper_code, paper_title: paper.paper_title, examination_type: paper.examination_type, course_code: course.course_code, course_name: course.course_name, examination_date: session.examination_date, start_time: session.start_time, end_time: session.end_time, room: examRoomMap.get(session.room_id) ?? null, session_status: session.status };
    });

    const eligibility = new Map<string, boolean>();
    async function eligible(year:any,semester:any){const key=String(year)+"/"+String(semester);if(!eligibility.has(key)){const r=await institutionDb.rpc("idmc_cw_eligible",{p_student:studentId,p_year:year,p_semester:semester});if(r.error)throw r.error;eligibility.set(key,r.data?.eligible===true);}return eligibility.get(key);}
    for(const list of [courseResults,semesterResults,cgpaRecords,courseAttempts]){for(let i=list.length-1;i>=0;i--){const row=list[i]!;if(!await eligible(row.academic_year_id,row.semester_id))list.splice(i,1);}}
    for(const row of examinationTimetable){const candidate=candidateMap.get(row.examination_candidate_id);const paper=paperMap.get(candidate?.examination_paper_id);const offering=offeringMap.get(paper?.course_offering_id);if(!offering||!await eligible(offering.academic_year_id,offering.semester_id))row.candidate_number=null;}
    const academicYears = await byIds("academic_years", [...registrations.map(item => item.academic_year_id), ...courseResults.map(item => item.academic_year_id), ...semesterResults.map(item => item.academic_year_id)]);
    const semesters = await byIds("semesters", [...registrations.map(item => item.semester_id), ...courseResults.map(item => item.semester_id), ...semesterResults.map(item => item.semester_id)]);
    const academicYearMap = new Map(academicYears.map(item => [item.id, item]));
    const semesterMap = new Map(semesters.map(item => [item.id, item]));
    const enrichPeriod = (item: Row) => ({ ...item, academic_year_name: academicYearMap.get(item.academic_year_id)?.year_name || academicYearMap.get(item.academic_year_id)?.year_code || null, semester_name: semesterMap.get(item.semester_id)?.semester_name || semesterMap.get(item.semester_id)?.semester_code || null });

    const classStudents = await rows("class_students", "student_id", studentId, "created_at");
    const studentClasses = await byIds("classes", classStudents.map(item => item.class_id));
    const announcementsResult = await institutionDb.from("announcements").select("*").eq("status", "PUBLISHED").order("publish_at", { ascending: false }).limit(100);
    if (announcementsResult.error) warnings.push(PORTAL_DATA_WARNING);
    const helpdeskMessages = helpdeskTickets.length ? await institutionDb.from("helpdesk_messages").select("*").in("ticket_id", helpdeskTickets.map(item => item.id)).order("created_at", { ascending: true }) : { data: [], error: null };
    if (helpdeskMessages.error) warnings.push(PORTAL_DATA_WARNING);
    const categoriesResult = await institutionDb.from("helpdesk_categories").select("*").eq("status", "ACTIVE").order("category_name");
    if (categoriesResult.error) warnings.push(PORTAL_DATA_WARNING);

    const hostelRows = await byIds("hostels", hostelAllocations.map(item => item.hostel_id));
    const hostelRooms = await byIds("hostel_rooms", hostelAllocations.map(item => item.room_id));
    const hostelBeds = await byIds("hostel_beds", hostelAllocations.map(item => item.bed_id));
    const hostelFees = hostelRows.length ? await institutionDb.from("hostel_fees").select("*").in("hostel_id", hostelRows.map(item => item.id)).eq("status", "ACTIVE") : { data: [], error: null };
    if (hostelFees.error) warnings.push(PORTAL_DATA_WARNING);
    const [placementSites, fieldOrganizations] = await Promise.all([
        byIds("placement_sites", clinicalPlacements.map(item => item.placement_site_id)),
        byIds("field_organizations", fieldPracticals.map(item => item.field_organization_id)),
    ]);
    const placementSiteMap = new Map(placementSites.map(item => [item.id, item]));
    const fieldOrganizationMap = new Map(fieldOrganizations.map(item => [item.id, item]));

    return {
        student: { ...student, department_name: department?.department_name || null, school_name: school?.school_name || null, campus_name: campus?.campus_name || null },
        applicant,
        application,
        application_choices: applicationChoices,
        application_next_of_kin: applicationKin,
        programmes: choiceProgrammes,
        academic_years: applicationYear ? [applicationYear] : [],
        current_year: currentYearResult.data?.year_name || currentYearResult.data?.year_code || null,
        last_login_at: userLogin.data?.last_login_at || null,
        application_documents: admissionDocuments,
        academic_qualifications: qualifications,
        emergency_contacts: emergencyContacts,
        guardians,
        registrations: registrations.map(enrichPeriod),
        course_registrations: courseRegistrations.map(enrichCourse),
        course_offerings: offerings,
        courses: courseMaster,
        student_classes: studentClasses,
        attendance_records: attendance,
        course_results: courseResults.map(item => enrichPeriod(enrichCourse(item))),
        semester_results: semesterResults.map(enrichPeriod),
        cgpa_records: cgpaRecords.map(enrichPeriod),
        course_attempts: courseAttempts.map(item => enrichPeriod(enrichCourse(item))),
        academic_deficiencies: deficiencies.map(enrichCourse),
        timetable_entries: timetable,
        examination_timetable: examinationTimetable,
        financial_account: account,
        invoices,
        payments,
        financial_transactions: transactions,
        student_documents: studentDocuments,
        notifications,
        announcements: announcementsResult.data ?? [],
        service_requests: requests,
        course_evaluations: evaluations,
        coursework_responses: courseworkResponses,
        helpdesk_categories: categoriesResult.data ?? [],
        helpdesk_tickets: helpdeskTickets,
        helpdesk_messages: helpdeskMessages.data ?? [],
        security_logs: securityLogs,
        hostel_allocations: hostelAllocations,
        hostels: hostelRows,
        hostel_rooms: hostelRooms,
        hostel_beds: hostelBeds,
        hostel_fees: hostelFees.data ?? [],
        clinical_placements: clinicalPlacements.map(item => ({ ...item, site: placementSiteMap.get(item.placement_site_id) ?? null, course: courseMap.get(item.course_id) ?? null })),
        field_practicals: fieldPracticals.map(item => ({ ...item, organization: fieldOrganizationMap.get(item.field_organization_id) ?? null, course: courseMap.get(item.course_id) ?? null })),
        scholarships,
        library: { member: libraryMember, loans: libraryLoans, reservations: libraryReservations, fines: libraryFines },
        assessments: assessmentsResult.data ?? [],
        assessment_submissions: submissionsResult,
        graduation_candidates: graduationCandidates,
        audit_warnings: warnings,
    };
}

export async function updateOwnProfile(req: Request, input: Row) {
    const student = await ownStudent(req);
    const payload = {
        phone: clean(input.phone, 50), email: clean(input.email, 255),
        physical_address: clean(input.physicalAddress, 1000), postal_address: clean(input.postalAddress, 1000),
        emergency_contact_name: clean(input.emergencyContactName, 200), emergency_contact_phone: clean(input.emergencyContactPhone, 50),
        updated_at: new Date().toISOString(),
    };
    const result = await institutionDb.from("students").update(payload).eq("id", student.id).select().single();
    if (result.error) throw new Error(`Unable to update student contact information: ${result.error.message}`);
    const profileResult = await institutionDb.from("student_profiles").upsert({ student_id: student.id, phone: payload.phone, email: payload.email, updated_at: payload.updated_at }, { onConflict: "student_id" });
    if (profileResult.error) throw new Error(`Student profile could not be synchronized: ${profileResult.error.message}`);
    return result.data;
}

export async function respondToCoursework(req: Request, input: Row) {
    const student = await ownStudent(req);
    const resultId = clean(input.courseResultId, 80);
    const status = String(input.responseStatus ?? "").toUpperCase();
    if (!resultId || !["ACCEPTED", "QUERY"].includes(status)) throw new StudentSelfServiceError("Course result and response are required.");
    const owned = await institutionDb.from("course_results").select("id,published_at,result_status").eq("id", resultId).eq("student_id", student.id).maybeSingle();
    if (owned.error || !owned.data) throw new StudentSelfServiceError("Published course result was not found for this student.", 404);
    if (!["PUBLISHED", "LOCKED"].includes(String(owned.data.result_status))) throw new StudentSelfServiceError("Only published coursework can be acknowledged.", 409);
    if (owned.data.published_at && Date.now() - new Date(owned.data.published_at).getTime() > 7 * 86400000) throw new StudentSelfServiceError("The seven-day coursework response period has ended.", 409);
    const payload = { student_id: student.id, course_result_id: resultId, response_status: status, student_comment: clean(input.comment), responded_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    const result = await institutionDb.from("student_coursework_responses").upsert(payload, { onConflict: "student_id,course_result_id" }).select().single();
    if (result.error) throw new Error(`Unable to save coursework response: ${result.error.message}`);
    return result.data;
}

export async function submitCourseEvaluation(req: Request, input: Row) {
    const student = await ownStudent(req);
    const offeringId = clean(input.courseOfferingId, 80);
    const rating = Number(input.rating);
    if (!offeringId || !Number.isInteger(rating) || rating < 1 || rating > 5) throw new StudentSelfServiceError("Registered course and rating from 1 to 5 are required.");
    const registered = await institutionDb.from("course_registrations").select("id").eq("student_id", student.id).eq("course_offering_id", offeringId).maybeSingle();
    if (registered.error || !registered.data) throw new StudentSelfServiceError("The selected course is not registered to this student.", 409);
    const optionalScore = (value: unknown) => value === "" || value === undefined || value === null ? null : Number(value);
    const payload = { student_id: student.id, course_offering_id: offeringId, rating, lecturer_preparation: optionalScore(input.lecturerPreparation), content_delivery: optionalScore(input.contentDelivery), learning_resources: optionalScore(input.learningResources), student_comment: clean(input.comment), submitted_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    const result = await institutionDb.from("student_course_evaluations").upsert(payload, { onConflict: "student_id,course_offering_id" }).select().single();
    if (result.error) throw new Error(`Unable to submit course evaluation: ${result.error.message}`);
    return result.data;
}

export async function submitServiceRequest(req: Request, input: Row) {
    const student = await ownStudent(req);
    const type = String(input.requestType ?? "").toUpperCase();
    const allowed = ["RESULT_APPEAL", "POSTPONEMENT", "TRANSCRIPT", "ID_CARD", "CERTIFICATE", "GRADUATION_GOWN", "GENERAL"];
    const subject = clean(input.subject, 200); const reason = clean(input.reason, 5000);
    if (!allowed.includes(type) || !subject || !reason) throw new StudentSelfServiceError("Request type, subject and reason are required.");
    const requestNumber = `REQ-${new Date().toISOString().slice(0,10).replaceAll("-","")}-${randomUUID().slice(0,8).toUpperCase()}`;
    const result = await institutionDb.from("student_service_requests").insert({ request_number: requestNumber, student_id: student.id, request_type: type, academic_year_id: clean(input.academicYearId, 80), semester_id: clean(input.semesterId, 80), subject, reason, evidence_url: clean(input.evidenceUrl, 2000), request_data: {}, status: "SUBMITTED", submitted_at: new Date().toISOString() }).select().single();
    if (result.error) throw new Error(`Unable to submit service request: ${result.error.message}`);
    return result.data;
}

export async function submitHelpdeskTicket(req: Request, input: Row) {
    const student = await ownStudent(req);
    const subject = clean(input.subject, 200); const description = clean(input.description, 5000);
    const priority = String(input.priority ?? "NORMAL").toUpperCase();
    if (!subject || !description) throw new StudentSelfServiceError("Help topic and description are required.");
    if (!["LOW", "NORMAL", "HIGH", "URGENT"].includes(priority)) throw new StudentSelfServiceError("Invalid helpdesk priority.");
    const ticketNumber = `HLP-${new Date().toISOString().slice(0,10).replaceAll("-","")}-${randomUUID().slice(0,8).toUpperCase()}`;
    const result = await institutionDb.from("helpdesk_tickets").insert({ institution_id: student.institution_id, ticket_number: ticketNumber, category_id: clean(input.categoryId, 80), requester_user_id: publicUserId(req), requester_student_id: student.id, subject, description, priority, status: "OPEN", source: "WEB" }).select().single();
    if (result.error) throw new Error(`Unable to create helpdesk ticket: ${result.error.message}`);
    return result.data;
}

export async function changeOwnPassword(req: Request, input: Row) {
    return changeAuthenticatedPassword(authUserId(req), String(input.currentPassword ?? ""), String(input.newPassword ?? ""), {
        ipAddress: req.ip,
        userAgent: req.get("user-agent") || undefined,
        source: "student-portal",
    });
}
