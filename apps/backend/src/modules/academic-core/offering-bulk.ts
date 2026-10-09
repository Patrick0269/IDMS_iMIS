import type { Request, Response, NextFunction } from 'express';
import { getSupabase } from '../../config/database.js';
import { validateOffering } from './academic-validation.js';
import { createAuditLog } from '../../services/audit.service.js';
const fields: Record<string,string>={academicYearId:'academic_year_id',semesterId:'semester_id',programmeId:'programme_id',programmeVersionId:'programme_version_id',courseId:'course_id',offeringCode:'offering_code',sectionName:'section_name',capacity:'capacity',minimumStudents:'minimum_students',deliveryMode:'delivery_mode',status:'status',registrationOpenAt:'registration_open_at',registrationCloseAt:'registration_close_at'};
function bad(message:string):never{throw Object.assign(new Error(message),{statusCode:400});}
export async function validateOfferingSelection(input:Record<string,any>):Promise<void>{
 if(!['4','5','6'].includes(String(input.level))||!Number.isInteger(Number(input.yearNumber))||Number(input.yearNumber)<1)bad('Select course level and a positive study year.');
 const db=getSupabase();const [course,semester,curricula]=await Promise.all([
  db.from('courses').select('id,level,status').eq('id',input.courseId).maybeSingle(),
  db.from('semesters').select('academic_year_id,semester_number').eq('id',input.semesterId).maybeSingle(),
  db.from('curricula').select('id').eq('programme_version_id',input.programmeVersionId).eq('status','ACTIVE')]);
 for(const r of [course,semester,curricula])if(r.error)throw r.error;
 if(!course.data||String(course.data.level).trim()!==String(input.level)||course.data.status!=='ACTIVE')bad('Course does not match the selected level.');
 if(!semester.data||semester.data.academic_year_id!==input.academicYearId)bad('Semester does not belong to the academic year.');
 const ids=(curricula.data||[]).map(c=>c.id);if(!ids.length)bad('No active curriculum in this programme version.');
 const mapped=await db.from('curriculum_courses').select('id').in('curriculum_id',ids).eq('course_id',input.courseId).eq('year_number',Number(input.yearNumber)).eq('semester_number',semester.data.semester_number).limit(1).maybeSingle();
 if(mapped.error)throw mapped.error;if(!mapped.data)bad('Course is not mapped to the selected study year and semester.');
}
export async function createOfferingBulk(req:Request,res:Response,next:NextFunction){
 try{
  const items=req.body?.items;if(!Array.isArray(items)||!items.length||items.length>100)bad('Choose 1 to 100 course offerings.');
  const codes=new Set<string>();const identities=new Set<string>();const rows=[];
  for(const input of items){if(!input||typeof input!=='object')bad('Invalid offering row.');const row:Record<string,any>={};for(const [key,column] of Object.entries(fields))if(input[key]!==undefined&&input[key]!=='')row[column]=input[key];
   const code=String(row.offering_code||'');const identity=[row.academic_year_id,row.semester_id,row.programme_id,row.programme_version_id,row.course_id,row.section_name||''].join('|');if(codes.has(code)||identities.has(identity))bad('Duplicate offering in selection.');codes.add(code);identities.add(identity);
   await validateOfferingSelection(input);await validateOffering(row);row.created_by=req.user!.id;rows.push(row);
  }
  // One INSERT commits all selected rows, or none on a constraint failure.
  const saved=await getSupabase().from('course_offerings').insert(rows).select('id,offering_code');if(saved.error)throw saved.error;
  try{await createAuditLog({actorUserId:req.user!.id,actionCode:'COURSE_OFFERINGS_BULK_CREATE',moduleCode:'ACADEMICS',entityType:'course_offerings',newValues:{ids:saved.data?.map(r=>r.id),count:rows.length}});}catch(error){console.warn('Offering batch audit failed',error);}
  res.status(201).json({success:true,data:{created:saved.data?.length||0,offerings:saved.data}});
 }catch(error){next(error);}
}
