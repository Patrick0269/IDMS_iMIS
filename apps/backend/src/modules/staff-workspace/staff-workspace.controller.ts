import type { NextFunction, Request, Response } from "express";
import { archiveStaffAccount, decideStudentRequest, getFinanceWorkspace, getLecturerWorkspace, getRegistrySummary, getRegistryWorkspace, listStaffAccounts, markLecturerAttendance, provisionStaffAccount, recordFinancePayment, recordLecturerMark, submitLecturerMark, submitLecturerResult } from "./staff-workspace.service.js";

function body(req: Request): Record<string, unknown> { return req.body && typeof req.body === "object" ? req.body : {}; }
async function run(res: Response, next: NextFunction, action: () => Promise<unknown>) {
  try { return res.json({ success: true, data: await action() }); }
  catch (error) { return next(error); }
}
export const lecturerWorkspace = (req: Request, res: Response, next: NextFunction) => run(res, next, () => getLecturerWorkspace(req));
export const lecturerAttendance = (req: Request, res: Response, next: NextFunction) => run(res, next, () => markLecturerAttendance(req, body(req)));
export const lecturerMark = (req: Request, res: Response, next: NextFunction) => run(res, next, () => recordLecturerMark(req, body(req)));
export const lecturerMarkSubmit = (req: Request, res: Response, next: NextFunction) => run(res, next, () => submitLecturerMark(req, body(req)));
export const lecturerResultSubmit = (req: Request, res: Response, next: NextFunction) => run(res, next, () => submitLecturerResult(req, body(req)));
export const financeWorkspace = (req: Request, res: Response, next: NextFunction) => run(res, next, () => getFinanceWorkspace(req));
export const financePayment = (req: Request, res: Response, next: NextFunction) => run(res, next, () => recordFinancePayment(req, body(req)));
export const registryWorkspace = (req: Request, res: Response, next: NextFunction) => run(res, next, () => getRegistryWorkspace(req));
export const registrySummary = (req: Request, res: Response, next: NextFunction) => run(res, next, () => getRegistrySummary(req));
export const registryRequestDecision = (req: Request, res: Response, next: NextFunction) => run(res, next, () => decideStudentRequest(req, body(req)));
export const staffAccounts = (_req: Request, res: Response, next: NextFunction) => run(res, next, () => listStaffAccounts());
export const staffAccountProvision = (req: Request, res: Response, next: NextFunction) => run(res, next, () => provisionStaffAccount(req, body(req)));
export const staffAccountArchive = (req: Request, res: Response, next: NextFunction) => run(res, next, () => archiveStaffAccount(req, String(req.params.staffId ?? "")));
