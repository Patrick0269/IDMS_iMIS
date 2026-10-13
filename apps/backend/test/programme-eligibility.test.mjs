import test from "node:test";
import assert from "node:assert/strict";
import { isEligibleForProgramme } from "../dist/modules/applicant-self-service/programme-eligibility.js";

const globalRule = {
  programme_id: "programme-1",
  intake_id: null,
  accepted_qualification_types: ["ADVANCED_LEVEL", "TECHNICIAN_CERTIFICATE"],
  minimum_qualification_level: null,
  require_verified_qualification: false,
};

test("no programme is eligible until an approved matching rule exists", () => {
  assert.equal(isEligibleForProgramme([], [{ qualification_type: "ADVANCED_LEVEL" }], "programme-1"), false);
  assert.equal(isEligibleForProgramme([globalRule], [{ qualification_type: "ADVANCED_LEVEL" }], "other-programme"), false);
});

test("configured qualification types control eligibility without granting all programs to Form Six", () => {
  assert.equal(isEligibleForProgramme([globalRule], [{ qualification_type: "ADVANCED_LEVEL" }], "programme-1"), true);
  assert.equal(isEligibleForProgramme([globalRule], [{ qualification_type: "CERTIFICATE", qualification_level: 4 }], "programme-1"), false);
});

test("minimum level and verified-only rules are enforced", () => {
  const rule = { ...globalRule, accepted_qualification_types: ["CERTIFICATE"], minimum_qualification_level: 5, require_verified_qualification: true };
  assert.equal(isEligibleForProgramme([rule], [{ qualification_type: "CERTIFICATE", qualification_level: 4, verification_status: "VERIFIED" }], "programme-1"), false);
  assert.equal(isEligibleForProgramme([rule], [{ qualification_type: "CERTIFICATE", qualification_level: 5, verification_status: "PENDING" }], "programme-1"), false);
  assert.equal(isEligibleForProgramme([rule], [{ qualification_type: "CERTIFICATE", qualification_level: 5, verification_status: "VERIFIED" }], "programme-1"), true);
  assert.equal(isEligibleForProgramme([rule], [{ qualification_type: "CERTIFICATE", qualification_level: 5, verification_status: "REJECTED" }], "programme-1"), false);
});

test("intake-specific rules take precedence over the programme-wide rule", () => {
  const intakeRule = { ...globalRule, intake_id: "intake-1", accepted_qualification_types: ["CERTIFICATE"] };
  assert.equal(isEligibleForProgramme([globalRule, intakeRule], [{ qualification_type: "ADVANCED_LEVEL" }], "programme-1", "intake-1"), false);
  assert.equal(isEligibleForProgramme([globalRule, intakeRule], [{ qualification_type: "ADVANCED_LEVEL" }], "programme-1", "another-intake"), true);
});
