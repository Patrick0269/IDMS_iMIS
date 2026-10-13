export type AdmissionRule = {
  programme_id: string;
  intake_id: string | null;
  accepted_qualification_types: string[];
  minimum_qualification_level: number | null;
  require_verified_qualification: boolean;
};

export type ApplicantQualification = {
  qualification_type?: string | null;
  qualification_level?: number | null;
  verification_status?: string | null;
};

/**
 * Admission rules are supplied by the institution. A programme without an
 * applicable, configured rule is deliberately ineligible until configured.
 * Intake-specific rules take precedence over a programme-wide rule.
 */
export function isEligibleForProgramme(
  rules: AdmissionRule[],
  qualifications: ApplicantQualification[],
  programmeId: string,
  intakeId?: string | null,
): boolean {
  const programmeRules = rules.filter((rule) => rule.programme_id === programmeId);
  const rule = (intakeId
    ? programmeRules.find((candidate) => candidate.intake_id === intakeId)
    : undefined) ?? programmeRules.find((candidate) => candidate.intake_id == null);

  if (!rule || !Array.isArray(rule.accepted_qualification_types) || rule.accepted_qualification_types.length === 0) return false;

  const acceptedTypes = new Set(rule.accepted_qualification_types.map((type) => String(type).toUpperCase()));
  return qualifications.some((qualification) => {
    const type = String(qualification.qualification_type ?? "").toUpperCase();
    if (!acceptedTypes.has(type) || String(qualification.verification_status ?? "").toUpperCase() === "REJECTED") return false;
    if (rule.minimum_qualification_level != null) {
      const level = Number(qualification.qualification_level);
      if (!Number.isFinite(level) || level < Number(rule.minimum_qualification_level)) return false;
    }
    return !rule.require_verified_qualification || String(qualification.verification_status ?? "").toUpperCase() === "VERIFIED";
  });
}
