export const SECTION_CONFIG = Object.freeze({
  courses: { actions: ["course", "crossCutting", "departmentGroup"] },
  curriculumCourses: { actions: ["curriculumCourse", "crossCutting"] },
  offerings: { actions: ["offering"] },
  years: { actions: ["year"] },
  semesters: { actions: ["semester"] },
  programmes: { actions: ["programme"] },
  versions: { actions: ["version"] },
  curricula: { actions: ["curriculum"] },
  prerequisites: { actions: ["prerequisite"] }
});
export const ACADEMIC_REGISTRY = {
    years: { label: "Academic Years", endpoint: "/academic-core/years", form: "year", columns: [["Year", "year_name"], ["Code", "year_code"], ["Start", "start_date"], ["End", "end_date"], ["Status", "status", "badge"]] },
    semesters: { label: "Semesters", endpoint: "/academic-core/semesters", form: "semester", columns: [["Semester", "semester_name"], ["Code", "semester_code"], ["Number", "semester_number"], ["Start", "start_date"], ["End", "end_date"], ["Status", "status", "badge"]] },
    programmes: { label: "Programmes", endpoint: "/academic-core/programmes", form: "programme", columns: [["Code", "programme_code"], ["Programme", "programme_name"], ["Award", "award_level"], ["Duration", "duration_years"], ["Status", "status", "badge"]] },
    versions: { label: "Programme Versions", endpoint: "/academic-core/programme-versions", form: "version", columns: [["Programme", "programme_id", "programme"], ["Version", "version_code"], ["Name", "version_name"], ["Effective", "effective_from"], ["Credits", "total_credits"], ["Status", "status", "badge"]] },
    courses: { label: "Course Master", endpoint: "/academic-core/courses", form: "course", columns: [["Code", "course_code"], ["Course", "course_name"], ["Credits", "credit_units"], ["Level", "level"], ["Type", "course_type"], ["Cross-cutting", "cross_cutting", "yesno"], ["Status", "status", "badge"]] },
    curricula: { label: "Curricula", endpoint: "/academic-core/curricula", form: "curriculum", columns: [["Programme Version", "programme_version_id", "version"], ["Code", "curriculum_code"], ["Curriculum", "curriculum_name"], ["Effective", "effective_from"], ["Credits", "total_credits"], ["Status", "status", "badge"]] },
    curriculumCourses: { label: "Curriculum Mapping", endpoint: "/academic-core/curriculum-courses", form: "curriculumCourse", columns: [["Curriculum", "curriculum_id", "curriculum"], ["Course", "course_id", "course"], ["Year", "year_number"], ["Semester", "semester_number"], ["Category", "course_category"], ["Compulsory", "is_compulsory", "yesno"], ["Credits", "credit_units"]] },
    prerequisites: { label: "Prerequisites", endpoint: "/academic-core/course-prerequisites", form: "prerequisite", columns: [["Course", "course_id", "course"], ["Required Previous Course", "prerequisite_course_id", "course"], ["Minimum Grade", "minimum_grade"]] },
    offerings: { label: "Course Offerings", endpoint: "/academic-core/course-offerings", form: "offering", columns: [["Offering", "offering_code"], ["Course", "course_id", "course"], ["Programme", "programme_id", "programme"], ["Section", "section_name"], ["Capacity", "capacity"], ["Status", "status", "badge"]] }
  };

