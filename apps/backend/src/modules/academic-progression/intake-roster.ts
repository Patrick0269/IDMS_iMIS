import type {Request} from 'express';
import {getSupabase} from '../../config/database.js';
import {rolesGrantRole,scopeRoleAssignments} from '../../utils/security.js';
type Row=Record<string,any>;
export async function intakeRoster<T extends Row>(req:Request,rows:T[]):Promise<T[]>{
 const db=getSupabase(),r=await db.from('user_roles').select('role_id,assigned_at,status,expires_at,roles!inner(role_code,status)').eq('user_id',req.user!.id).eq('status','ACTIVE');if(r.error)throw r.error;const scoped=scopeRoleAssignments(r.data,req.user!.activeRoleId);if(scoped[0]?.role_id)req.user!.activeRoleId=scoped[0].role_id;
 const lecturer=rolesGrantRole(scoped,['LECTURER'])&&(req.query.view==='lecturer'||!rolesGrantRole(scoped,['ACADEMIC_OFFICER','HOD','DEPUTY_HOD']));
 const selected=String(req.query.intakeCode||'');if(selected&&!['MARCH','SEPTEMBER'].includes(selected))throw Object.assign(new Error('Select March or September intake.'),{statusCode:400});
 if(!lecturer&&!selected)return rows;if(!rows.length)return [];
 const students=await db.from('students').select('id,idmc_intakes!students_intake_id_fkey(code)').in('id',[...new Set(rows.map(r=>r.student_id))]);if(students.error)throw students.error;
 const codes=new Map((students.data||[]).map((s:any)=>[s.id,s.idmc_intakes?.code]));
 const windows=lecturer?await db.from('idmc_intake_result_windows').select('*').in('offering_id',[...new Set(rows.map(r=>r.course_offering_id))]):{data:[],error:null};if(windows.error)throw windows.error;
 const now=Date.now();if(lecturer&&!selected&&new Set((windows.data||[]).filter(w=>w.is_open&&Date.parse(w.opens_at)<=now&&Date.parse(w.closes_at)>now).map(w=>w.intake_code)).size>1)throw Object.assign(new Error('Choose March or September before loading this marks roster.'),{statusCode:400});return rows.filter(row=>{const code=codes.get(row.student_id);return (!selected||selected===code)&&(!lecturer||(windows.data||[]).some(w=>w.offering_id===row.course_offering_id&&w.intake_code===code&&w.is_open&&Date.parse(w.opens_at)<=now&&Date.parse(w.closes_at)>now));});
}
