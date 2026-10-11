/* IDMS student navigation: existing student pages only. */
export const STUDENT_NAV = [
  { id: "home", label: "Home", icon: "⌂", href: "student-portal.html" },
  { id: "student-info", label: "Student Info", icon: "▣", children: [
    { label: "My Profile", href: "student-profile.html" },
    { label: "Registration Form", href: "student-application.html" },
    { label: "Registered Modules", href: "student-registration.html" },
    { label: "Documents", href: "student-documents.html" }
  ] },
  { id: "timetable", label: "Timetable", icon: "▦", children: [
    { label: "Class Timetable", href: "student-timetable.html" },
    { label: "Examination Timetable", href: "student-timetable.html?view=examinations" }
  ] },
  { id: "academic", label: "Academic", icon: "▤", children: [
    { label: "Attendance", href: "student-attendance.html" },
    { label: "Results", href: "student-results.html" },
    { label: "Coursework Scores", href: "student-coursework.html" },
    { label: "Course Evaluation", href: "student-evaluation.html" },
    { label: "Repeat / Carry Modules", href: "student-coursework.html" },
    { label: "Transcript", href: "student-transcript.html" },
    { label: "Placements", href: "student-placements.html" }
  ] },
  { id: "financial", label: "Financial", icon: "¤", children: [
    { label: "Payment Information", href: "student-fees.html?view=information" },
    { label: "Fees Statement", href: "student-fees.html?view=statement" },
    { label: "Payment History", href: "student-fees.html?view=history" }
  ] },
  { id: "accommodation", label: "Accommodation", icon: "⌂", children: [
    { label: "Room Allocation", href: "student-accommodation.html" },
    { label: "Accommodation History", href: "student-accommodation.html?view=history" }
  ] },
  { id: "requests", label: "Requests", icon: "↗", children: [
    { label: "Result Appeal", href: "student-request-center.html?type=RESULT_APPEAL" },
    { label: "Postponement", href: "student-request-center.html?type=POSTPONEMENT" },
    { label: "Transcript Request", href: "student-request-center.html?type=TRANSCRIPT" },
    { label: "ID Card Request", href: "student-request-center.html?type=ID_CARD" },
    { label: "Certificate Request", href: "student-request-center.html?type=CERTIFICATE" },
    { label: "Graduation Gown", href: "student-request-center.html?type=GRADUATION_GOWN" },
    { label: "General Request / Suggestion", href: "student-request-center.html?type=GENERAL" }
  ] },
  { id: "communication", label: "Communication", icon: "●", children: [
    { label: "News & Events", href: "student-notifications.html?view=news" },
    { label: "Notifications", href: "student-notifications.html" }
  ] },
  { id: "help", label: "Help", icon: "?", children: [
    { label: "Instructions", href: "student-help.html#instructions" },
    { label: "FAQs", href: "student-help.html#faqs" },
    { label: "Contact Support", href: "student-help.html#helpForm" }
  ] },
  { id: "security", label: "Security", icon: "⚿", children: [
    { label: "Change Password", href: "student-security.html#passwordForm" },
    { label: "Login History", href: "student-security.html#securityHistory" }
  ] }
];

export const STUDENT_INSTITUTION = {
  name: "Institute of Development and Medical Sciences",
  acronym: "IDMS",
  website: "http://www.idmc.ac.tz"
};
