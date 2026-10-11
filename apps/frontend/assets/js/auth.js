(function () {
    "use strict";

    const CONFIG = window.IDMC_CONFIG;

    if (!CONFIG) {
        console.error("IDMC_CONFIG is missing.");
        return;
    }

    const STORAGE_KEY = "idmc_session";
    const USER_KEY = "idmc_user";
    const REDIRECT_KEY = "idmc_redirect";
    const ACTIVE_ROLE_KEY = "idmc_active_role";
    const REQUEST_TIMEOUT_MS = 25000;
    const SESSION_VALIDATION_TIMEOUT_MS = 12000;

    async function fetchWithTimeout(url, options, timeoutMs = REQUEST_TIMEOUT_MS) {
        const controller = new AbortController();
        const timeoutId = window.setTimeout(function () {
            controller.abort();
        }, timeoutMs);

        try {
            return await fetch(url, {
                ...(options || {}),
                signal: controller.signal
            });
        } catch (error) {
            if (error && error.name === "AbortError") {
                throw new Error(
                    `The IDMC service did not respond within ${Math.ceil(timeoutMs / 1000)} seconds. Please retry.`
                );
            }

            throw error;
        } finally {
            window.clearTimeout(timeoutId);
        }
    }

    function saveSession(session) {
        if (!session || !session.access_token) {
            throw new Error("Invalid authentication session received.");
        }

        sessionStorage.setItem(
            STORAGE_KEY,
            JSON.stringify({
                access_token: session.access_token,
                refresh_token: session.refresh_token || null,
                expires_at: session.expires_at || null,
                expires_in: session.expires_in || null,
                token_type: session.token_type || "bearer"
            })
        );
    }

    function getSession() {
        try {
            const raw = sessionStorage.getItem(STORAGE_KEY);
            return raw ? JSON.parse(raw) : null;
        } catch (error) {
            console.error("Could not read session:", error);
            return null;
        }
    }

    function clearSession() {
        sessionStorage.removeItem(STORAGE_KEY);
        sessionStorage.removeItem(USER_KEY);
        sessionStorage.removeItem(REDIRECT_KEY);
        sessionStorage.removeItem(ACTIVE_ROLE_KEY);
    }

    function getAccessToken() {
        return getSession()?.access_token || null;
    }

    function saveUser(data) {
        sessionStorage.setItem(USER_KEY, JSON.stringify(data));
    }

    function getUser() {
        try {
            const raw = sessionStorage.getItem(USER_KEY);
            return raw ? JSON.parse(raw) : null;
        } catch {
            return null;
        }
    }

    function redirectToLogin() {
        const currentPage = window.location.pathname.split("/").pop();

        if (
            currentPage &&
            currentPage !== "login.html" &&
            currentPage !== ""
        ) {
            sessionStorage.setItem(REDIRECT_KEY, currentPage);
        }

        window.location.replace("login.html");
    }

    function landingPage() {
        const user = getUser();
        if (user?.mustChangePassword) return "student-first-password.html";
        const roles = (user?.roles || []).filter(role => role && role.id);
        if (!roles.length) return "access-denied.html";
        const activeId = user.activeRoleId || sessionStorage.getItem(ACTIVE_ROLE_KEY);
        const activeRole = roles.find(role => String(role.id) === String(activeId)) || defaultRole(roles);
        if (!activeRole) return "access-denied.html";
        const codes = [String(activeRole.roleCode || activeRole.role_code || "").toUpperCase()];
        const routes = [
            [["SUPER_ADMIN", "ADMIN", "SYSTEM_ADMIN"], "dashboard.html"],
            [["PRINCIPAL"], "principal-portal.html"],
            [["DEPUTY_PRINCIPAL"], "deputy-principal-portal.html"],
            [["DIRECTOR"], "director-portal.html"],
            [["STUDENT"], "student-portal.html"],
            [["APPLICANT"], "applicant-portal.html"],
            [["FINANCE_OFFICER", "ACCOUNTANT", "FINANCE_MANAGER"], "finance-portal.html"],
            [["ADMISSIONS_OFFICER"], "admission-portal.html"],
            [["HOD", "DEPUTY_HOD"], "hod-portal.html"],
            [["REGISTRAR", "ACADEMIC_OFFICER"], "registry-portal.html"],
            [["EXAMINATION_OFFICER", "EXAMINATIONS_OFFICER", "EXAM_OFFICER"], "examination-portal.html"],
            [["HR_OFFICER", "HR_MANAGER", "HUMAN_RESOURCES"], "hr-portal.html"],
            [["PROCUREMENT_OFFICER"], "procurement-portal.html"],
            [["STORE_OFFICER"], "inventory-portal.html"],
            [["OPERATIONS_OFFICER"], "operations-portal.html"],
            [["QUALITY_ASSURANCE", "QA_OFFICER"], "qa-portal.html"],
            [["RESEARCH_OFFICER"], "research-portal.html"],
            [["COMMUNICATIONS_OFFICER"], "communications-portal.html"],
            [["DOCUMENTS_OFFICER"], "documents-portal.html"],
            [["HELPDESK_OFFICER"], "helpdesk-portal.html"],
            [["AUDITOR"], "auditor-portal.html"],
            [["REPORTS_OFFICER", "REPORTING_OFFICER"], "reports-portal.html"],
            [["DISCIPLINE_OFFICER"], "discipline.html"],
            [["COUNSELLOR", "WELFARE_OFFICER"], "student-welfare.html"],
            [["TRANSPORT_OFFICER"], "transport.html"],
            [["BUDGET_OFFICER"], "budget-management.html"],
            [["RISK_OFFICER"], "risk-register.html"],
            [["PLANNING_OFFICER"], "strategic-planning.html"],
            [["BOARD_SECRETARY"], "management-meetings.html"],
            [["GRIEVANCE_OFFICER"], "grievances.html"],
            [["ACCREDITATION_OFFICER"], "accreditation-management.html"],
            [["LIBRARIAN"], "library-portal.html"],
            [["LECTURER"], "lecturer-portal.html"],
            [["ALUMNI"], "alumni-portal.html"]
        ];

        for (const [roleCodes, page] of routes) {
            if (roleCodes.some(code => codes.includes(code))) return page;
        }
        if (codes.some(code => ["STAFF", "HR_OFFICER"].includes(code)) && !codes.some(code => ["SUPER_ADMIN", "ADMIN", "SYSTEM_ADMIN"].includes(code))) return "staff-portal.html";
        return "access-denied.html";
    }

    function defaultRole(roles) {
        const admin = roles.find(role => ["SUPER_ADMIN", "ADMIN", "SYSTEM_ADMIN"].includes(String(role.roleCode || role.role_code || "").toUpperCase()));
        return admin || roles[0] || null;
    }

    function getActiveRoleId() {
        const user = getUser();
        const assigned = user?.roles || [];
        const backendActive = assigned.find(role => String(role.id) === String(user?.activeRoleId));
        if (backendActive?.id) return String(backendActive.id);
        const stored = sessionStorage.getItem(ACTIVE_ROLE_KEY);
        const active = assigned.find(role => String(role.id) === String(stored));
        const selected = active || defaultRole(assigned);
        return selected?.id ? String(selected.id) : null;
    }

    function setActiveRole(roleId) {
        const user = getUser();
        const role = (user?.roles || []).find(item => String(item.id) === String(roleId));
        if (!role) throw new Error("That role is not assigned to this account.");
        sessionStorage.setItem(ACTIVE_ROLE_KEY, String(role.id));
        if (user) { user.activeRoleId = String(role.id); saveUser(user); }
        return role;
    }

    function redirectAfterLogin() {
        if (getUser()?.mustChangePassword) { window.location.replace("student-first-password.html"); return; }
        sessionStorage.removeItem(REDIRECT_KEY);
        const user = getUser();
        const defaultActive = (user?.roles || []).find(role => String(role.id) === String(user?.activeRoleId)) || defaultRole(user?.roles || []);
        if (defaultActive) setActiveRole(defaultActive.id);
        window.location.replace(landingPage());
    }

    async function parseResponse(response, timeoutMs = REQUEST_TIMEOUT_MS) {
        let timeoutId;
        let text;
        try {
            text = await Promise.race([
                response.text(),
                new Promise((_, reject) => {
                    timeoutId = window.setTimeout(() => {
                        try {
                            const cancellation = response.body?.cancel?.();
                            cancellation?.catch?.(() => undefined);
                        } catch { /* the timeout should still reject if body cancellation is unsupported */ }
                        reject(new Error(`The IDMC service response timed out after ${Math.ceil(timeoutMs / 1000)} seconds. Please retry.`));
                    }, timeoutMs);
                })
            ]);
        } finally {
            window.clearTimeout(timeoutId);
        }

        if (!text) {
            return {};
        }

        try {
            return JSON.parse(text);
        } catch {
            return {
                message: text
            };
        }
    }

    async function login(identifier, password) {
        identifier = String(identifier || "").trim();
        password = String(password || "");

        if (!identifier) {
            throw new Error("Please enter your Registration Number, Application Number or email.");
        }

        if (!password) {
            throw new Error("Please enter your password.");
        }

        if (!CONFIG.API_BASE_URL) {
            throw new Error("Backend API URL is not configured.");
        }

        let response;

        try {
            response = await fetchWithTimeout(
                `${CONFIG.API_BASE_URL}/auth/login`,
                {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({
                        identifier,
                        password
                    })
                }
            );
        } catch (error) {
            console.error("Backend connection error:", error);
            const networkFailure = error?.name === "TypeError" || /failed to fetch|networkerror/i.test(String(error?.message || ""));
            throw new Error(networkFailure
                ? `Imeshindikana kufikia huduma ya IDMC (${CONFIG.API_BASE_URL}). Angalia intaneti, kisha ujaribu tena.`
                : error?.message || "Unable to connect to the configured IDMC backend.");
        }

        const data = await parseResponse(response);

        if (!response.ok || !data?.success) {
            throw new Error(
                data?.message ||
                data?.error ||
                "Login failed."
            );
        }

        saveSession(data.data);

        return data.data;
    }

    async function studentLogin(studentNumber, password) {
        studentNumber = String(studentNumber || "").trim().replace(/\s+/g, "").toUpperCase();
        password = String(password || "");

        if (!/^(?:IDMC\/\d{4}\/\d{5}|N[A-Z]\d{4}\/\d{4}\/\d{4})$/.test(studentNumber)) {
            throw new Error("Enter a valid Student Number or Registration Number.");
        }
        if (!password) {
            throw new Error("Please enter your password.");
        }

        let response;
        try {
            response = await fetchWithTimeout(`${CONFIG.API_BASE_URL}/auth/student-login`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ studentNumber, password })
            });
        } catch (error) {
            console.error("Student login connection error:", error);
            throw new Error("Unable to connect to the configured IDMC backend.");
        }

        const data = await parseResponse(response, SESSION_VALIDATION_TIMEOUT_MS);
        if (!response.ok || !data?.success || !data?.data?.access_token) {
            throw new Error(data?.message || "Student login failed.");
        }

        saveSession(data.data);
        return data.data;
    }

    async function requestVerifiedPasswordReset(fields) {
        const response = await fetchWithTimeout(`${CONFIG.API_BASE_URL}/auth/password-reset`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(fields || {})
        });
        const data = await parseResponse(response);
        if (!response.ok || !data?.success) throw new Error(data?.message || "Unable to request password reset.");
        return data;
    }

    async function supabaseLogin(identifier, password) {
        identifier = String(identifier || "").trim();
        password = String(password || "");

        if (!identifier) {
            throw new Error("Please enter your email, username or student number.");
        }

        if (!password) {
            throw new Error("Please enter your password.");
        }

        if (!CONFIG.API_BASE_URL) {
            throw new Error("Backend API URL is not configured.");
        }

        let response;
        try {
            response = await fetchWithTimeout(`${CONFIG.API_BASE_URL}/auth/login`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ identifier, password })
            });
        } catch (error) {
            console.error("Backend login connection error:", error);
            throw new Error("Unable to connect to IDMC backend.");
        }

        const payload = await parseResponse(response);
        if (!response.ok || !payload?.success || !payload?.data?.access_token) {
            throw new Error(payload?.message || "Login failed.");
        }

        saveSession(payload.data);
        return payload.data;
    }
    let currentUserRequest = null;
    function getCurrentUser() {
        if (!currentUserRequest) {
            currentUserRequest = loadCurrentUser().finally(function () { currentUserRequest = null; });
        }
        return currentUserRequest;
    }

    async function loadCurrentUser() {
        const token = getAccessToken();

        if (!token) {
            throw new Error("No authentication session.");
        }

        if (!CONFIG.API_BASE_URL) {
            throw new Error("Backend API URL is not configured.");
        }

        let response;

        try {
            const headers = {
                "Authorization": `Bearer ${token}`,
                "Content-Type": "application/json"
            };
            const activeRoleId = sessionStorage.getItem(ACTIVE_ROLE_KEY);
            if (activeRoleId) headers["X-IDMC-Active-Role"] = activeRoleId;
            response = await fetchWithTimeout(
                `${CONFIG.API_BASE_URL}/auth/me`,
                {
                    method: "GET",
                    headers
                },
                SESSION_VALIDATION_TIMEOUT_MS
            );
        } catch (error) {
            console.error("Backend connection error:", error);
            const detail = String(error?.message || "");
            if (/failed to fetch|networkerror|load failed/i.test(detail)) {
                throw new Error(`Imeshindikana kuwasiliana na seva ya IDMC (${CONFIG.API_BASE_URL}). Hakikisha intaneti inafanya kazi, kisha bonyeza “Jaribu tena kuthibitisha akaunti”.`);
            }
            throw new Error(detail || "Unable to connect to the configured IDMC backend.");
        }

        const data = await parseResponse(response, SESSION_VALIDATION_TIMEOUT_MS);

        if (!response.ok) {
            throw new Error(
                data?.message ||
                data?.error ||
                "Unable to load user profile."
            );
        }

        if (!data.success || !data.data) {
            throw new Error("Invalid authentication response.");
        }

        saveUser(data.data);
        if (data.data.mustChangePassword && !window.location.pathname.endsWith("/student-first-password.html")) {
            window.location.replace("student-first-password.html");
        }

        return data.data;
    }

    async function refreshSession() {
        const session = getSession();

        if (!session?.refresh_token) {
            return null;
        }

        let response;

        try {
            response = await fetchWithTimeout(
                `${CONFIG.SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`,
                {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "apikey": CONFIG.SUPABASE_ANON_KEY,
                        "Authorization": `Bearer ${CONFIG.SUPABASE_ANON_KEY}`
                    },
                    body: JSON.stringify({
                        refresh_token: session.refresh_token
                    })
                },
                SESSION_VALIDATION_TIMEOUT_MS
            );
        } catch (error) {
            console.error("Session refresh failed:", error);
            clearSession();
            return null;
        }

        if (!response.ok) {
            clearSession();
            return null;
        }

        let newSession;
        try {
            newSession = await parseResponse(response, SESSION_VALIDATION_TIMEOUT_MS);
        } catch (error) {
            console.warn("Session refresh response could not be read:", error);
            clearSession();
            return null;
        }

        if (!newSession?.access_token) {
            clearSession();
            return null;
        }

        saveSession(newSession);

        return newSession;
    }

    async function logout() {
        const token = getAccessToken();

        try {
            if (token) {
                await fetchWithTimeout(
                    `${CONFIG.SUPABASE_URL}/auth/v1/logout`,
                    {
                        method: "POST",
                        headers: {
                            "Authorization": `Bearer ${token}`,
                            "apikey": CONFIG.SUPABASE_ANON_KEY
                        }
                    },
                    4000
                );
            }
        } catch (error) {
            console.warn("Logout request failed:", error);
        } finally {
            clearSession();
            window.location.replace("login.html");
        }
    }

    function hasPermission(permission) {
        const user = getUser();

        if (!user) return false;
        const activeRole = (user.roles || []).find(role => String(role.id) === String(getActiveRoleId()));
        if (activeRole && Array.isArray(activeRole.permissions)) return activeRole.permissions.includes(permission);
        return Array.isArray(user.permissions) && user.permissions.includes(permission);
    }

    function hasAnyPermission(permissions) {
        if (!Array.isArray(permissions)) return false;

        return permissions.some(permission =>
            hasPermission(permission)
        );
    }

    function hasAllPermissions(permissions) {
        if (!Array.isArray(permissions)) return false;

        return permissions.every(permission =>
            hasPermission(permission)
        );
    }

    function hasRole(roleCode) {
        const user = getUser();

        if (!user) return false;

        return (
            Array.isArray(user.roles) &&
            user.roles.some(role =>
                role.roleCode === roleCode ||
                role.role_code === roleCode
            )
        );
    }

    async function requireAuth() {
        let session = getSession();

        if (!session) {
            redirectToLogin();
            return null;
        }

        try {
            return await getCurrentUser();
        } catch (error) {
            console.warn("Session validation failed:", error);

            const refreshed = await refreshSession();

            if (!refreshed) {
                clearSession();
                redirectToLogin();
                return null;
            }

            try {
                return await getCurrentUser();
            } catch (secondError) {
                console.error(
                    "Authentication failed after refresh:",
                    secondError
                );

                clearSession();
                redirectToLogin();
                return null;
            }
        }
    }

    function requirePermission(permission) {
        if (!hasPermission(permission)) {
            alert(
                `Access denied.\nRequired permission: ${permission}`
            );

            window.location.replace("dashboard.html");
            return false;
        }

        return true;
    }

    function getPrimaryRole() {
        const user = getUser();
        return (user?.roles || []).find(role => String(role.id) === String(getActiveRoleId())) || null;
    }

    function getDisplayName() {
        const user = getUser();

        return (
            user?.user?.displayName ||
            user?.user?.display_name ||
            user?.user?.email ||
            "IDMC User"
        );
    }

    window.IDMCAuth = {
        saveSession,
        getSession,
        clearSession,
        getAccessToken,
        saveUser,
        getUser,
        login,
        studentLogin,
        requestVerifiedPasswordReset,
        supabaseLogin,
        getCurrentUser,
        refreshSession,
        logout,
        requireAuth,
        requirePermission,
        hasPermission,
        hasAnyPermission,
        hasAllPermissions,
        hasRole,
        getPrimaryRole,
        getActiveRoleId,
        setActiveRole,
        getLandingPage: landingPage,
        getDisplayName,
        redirectToLogin,
        redirectAfterLogin
    };

})();
