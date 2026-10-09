export const FORM_DEFINITIONS = {
    departmentGroup: { title: "Assign Department Section", endpoint: "/academic-core/workspace/departments", fields: [["departmentId", "Existing Department", "select", "departments", true], ["group", "Academic Section", "choices", ["SOCIAL", "PROJECT"], true]] },
    year: { title: "Add Academic Year", endpoint: "/academic-core/years", fields: [
      ["yearCode", "Year Code", "text", null, true, "Example: 2027/2028"],
      ["yearName", "Year Name", "text", null, true, "Example: Academic Year 2027/2028"],
      ["startDate", "Start Date", "date", null, true], ["endDate", "End Date", "date", null, true],
      ["status", "Status", "choices", ["PLANNED", "ACTIVE", "CLOSED", "ARCHIVED"], true]
    ]},
    semester: { title: "Add Semester", endpoint: "/academic-core/semesters", fields: [
      ["academicYearId", "Academic Year", "select", "years", true], ["semesterNumber", "Semester Number", "number", null, true],
      ["semesterCode", "Semester Code", "text", null, true, "Example: SEM1"], ["semesterName", "Semester Name", "text", null, true],
      ["startDate", "Start Date", "date", null, true], ["endDate", "End Date", "date", null, true],
      ["status", "Status", "choices", ["PLANNED", "ACTIVE", "CLOSED", "ARCHIVED"], true]
    ]},
    programme: { title: "Add Programme", endpoint: "/academic-core/programmes", fields: [
      ["institutionId", "Institution", "institution", null, true], ["schoolId", "School", "selectOptional", "schools", false],
      ["departmentId", "Department", "selectOptional", "departments", false], ["programmeCode", "Programme Code", "text", null, true],
      ["programmeName", "Programme Name", "text", null, true], ["programmeType", "Programme Type", "choices", ["ACADEMIC", "PROFESSIONAL", "SHORT_COURSE", "CERTIFICATE", "OTHER"], true],
      ["awardLevel", "Award Level", "text", null, true], ["durationYears", "Duration (years)", "number", null, true],
      ["modeOfStudy", "Mode of Study", "choices", ["FULL_TIME", "PART_TIME", "EVENING", "WEEKEND", "DISTANCE", "ONLINE", "BLENDED"], true],
      ["specialization", "Specialization", "text", null, false], ["directEntryRequirements", "Direct Entry Requirements", "textarea", null, false],
      ["status", "Status", "choices", ["ACTIVE", "INACTIVE", "SUSPENDED", "ARCHIVED"], true], ["description", "Description", "textarea", null, false]
    ]},
    version: { title: "Add Programme Version", endpoint: "/academic-core/programme-versions", fields: [
      ["programmeId", "Programme", "select", "programmes", true], ["versionCode", "Version Code", "text", null, true, "Example: 2026"],
      ["versionName", "Version Name", "text", null, false], ["effectiveFrom", "Effective From", "date", null, true],
      ["effectiveTo", "Effective To", "date", null, false], ["totalCredits", "Total Credits", "number", null, false],
      ["status", "Status", "choices", ["DRAFT", "ACTIVE", "RETIRED", "ARCHIVED"], true]
    ]},
    course: { title: "Add Course", endpoint: "/academic-core/courses", fields: [
      ["institutionId", "Institution", "institution", null, true], ["departmentId", "Department", "select", "departments", true],
      ["crossCutting", "Shared cross-cutting course", "choices", ["false", "true"], true],
      ["courseCode", "Course Code", "text", null, true], ["courseName", "Course Name", "text", null, true],
      ["courseShortName", "Short Name", "text", null, false], ["creditUnits", "Credit Units", "number", null, true],
      ["contactHours", "Contact Hours", "number", null, false], ["courseType", "Course Type", "choices", ["CORE", "ELECTIVE", "OPTIONAL", "GENERAL", "PRACTICAL", "FIELD", "CLINICAL", "PROJECT", "OTHER"], true],
      ["level", "Level", "text", null, false], ["status", "Status", "choices", ["ACTIVE", "INACTIVE", "RETIRED", "ARCHIVED"], true],
      ["description", "Description", "textarea", null, false],
      ["autoMap", "Automatically map to programme curriculum", "choices", ["true", "false"], true],
      ["programmeId", "Programme (auto if unique)", "selectOptional", "programmes", false],
      ["curriculumId", "Curriculum (auto if unique)", "selectOptional", "curricula", false],
      ["yearNumber", "Study Year", "number", null, false], ["semesterNumber", "Study Semester", "number", null, false],
      ["mappingCredits", "Programme Credits (blank uses Course Master)", "number", null, false],
      ["courseCategory", "Programme Category (blank uses Course Master)", "choices", ["CORE", "ELECTIVE", "OPTIONAL", "GENERAL", "PRACTICAL", "FIELD", "CLINICAL", "PROJECT", "OTHER"], false],
      ["academicYearId", "Open offering in academic year (optional)", "selectOptional", "years", false],
      ["semesterId", "Offering semester (optional)", "selectOptional", "semesters", false]
    ]},
    curriculum: { title: "Add Curriculum", endpoint: "/academic-core/curricula", fields: [
      ["programmeVersionId", "Programme Version", "select", "versions", true], ["curriculumCode", "Curriculum Code", "text", null, true],
      ["curriculumName", "Curriculum Name", "text", null, true], ["effectiveFrom", "Effective From", "date", null, true],
      ["effectiveTo", "Effective To", "date", null, false], ["totalCredits", "Total Credits", "number", null, false],
      ["status", "Status", "choices", ["DRAFT", "ACTIVE", "RETIRED", "ARCHIVED"], true]
    ]},
    curriculumCourse: { title: "Add Course to Curriculum", endpoint: "/academic-core/curriculum-courses", fields: [
      ["curriculumId", "Curriculum", "select", "curricula", true], ["courseId", "Course(s)", "courseChecklist", "courses", true],
      ["isCompulsory", "Compulsory", "choices", ["true", "false"], true]
    ]},
    crossCutting: { title: "Add Cross-cutting Course", endpoint: "/academic-core/course-offerings", fields: [
      ["courseId", "Courses to share across programmes", "crossCuttingChecklist", "courses", true],
      ["academicYearId", "Academic Year", "select", "years", true], ["semesterId", "Semester", "select", "semesters", true],
      ["curriculumTargets", "Target Curricula and Class Credits", "curriculumChecklist", "curricula", true],
      ["crossCreditMatrix", "Credits for each selected course and class", "crossCreditMatrix", null, false],
      ["isCompulsory", "Compulsory for target curricula", "choices", ["true", "false"], true]
    ]},
    prerequisite: { title: "Add Course Prerequisite", endpoint: "/academic-core/course-prerequisites", fields: [
      ["courseId", "Course", "select", "courses", true], ["prerequisiteCourseId", "Required Previous Course", "select", "courses", true],
      ["minimumGrade", "Minimum Grade", "text", null, false, "Example: C"]
    ]},
    offering: { title: "Add Course Offering", endpoint: "/academic-core/course-offerings", fields: [
      ["academicYearId", "Academic Year", "select", "years", true], ["semesterId", "Semester", "select", "semesters", true],
      ["programmeId", "Programme", "select", "programmes", true], ["programmeVersionId", "Programme Version", "select", "versions", true],
      ["level", "Course Level", "choices", ["4","5","6"], true], ["yearNumber", "Study Year", "number", null, true],
      ["courseId", "Course", "select", "courses", true], ["offeringCode", "Offering Code / Prefix", "text", null, false],
      ["sectionName", "Section / Stream", "text", null, false], ["capacity", "Capacity", "number", null, true],
      ["minimumStudents", "Minimum Students", "number", null, true], ["deliveryMode", "Delivery Mode", "choices", ["ON_CAMPUS", "ONLINE", "HYBRID", "DISTANCE", "FIELD", "CLINICAL"], true],
      ["registrationOpenAt", "Registration Opens", "datetime-local", null, false], ["registrationCloseAt", "Registration Closes", "datetime-local", null, false],
      ["status", "Status", "choices", ["DRAFT", "OPEN", "CLOSED", "SUSPENDED", "COMPLETED", "CANCELLED"], true]
    ]}
  };

