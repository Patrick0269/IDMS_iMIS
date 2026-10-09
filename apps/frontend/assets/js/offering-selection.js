export function eligibleOfferingCourses(lookups,payload){
 const semester=(lookups.semesters||[]).find(s=>s.id===payload.semesterId&&s.academic_year_id===payload.academicYearId);
 const version=(lookups.versions||[]).find(v=>v.id===payload.programmeVersionId&&v.programme_id===payload.programmeId&&v.status==='ACTIVE');
 if(!semester||!version||!payload.level||!Number.isInteger(Number(payload.yearNumber))||Number(payload.yearNumber)<1)return [];
 const curricula=new Set((lookups.curricula||[]).filter(c=>c.programme_version_id===version.id&&c.status==='ACTIVE').map(c=>c.id));
 const mapped=new Set((lookups.curriculumCourses||[]).filter(m=>curricula.has(m.curriculum_id)&&Number(m.semester_number)===Number(semester.semester_number)&&Number(m.year_number)===Number(payload.yearNumber)).map(m=>m.course_id));
 return (lookups.courses||[]).filter(c=>c.status==='ACTIVE'&&String(c.level).trim()===String(payload.level)&&mapped.has(c.id));
}
