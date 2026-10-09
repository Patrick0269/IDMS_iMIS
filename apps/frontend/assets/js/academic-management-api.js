function rowsFrom(response) {
  const payload = response && Object.prototype.hasOwnProperty.call(response, "data")
    ? response.data
    : response;
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.items)) return payload.items;
  if (payload && Array.isArray(payload.rows)) return payload.rows;
  return [];
}

export async function fetchAllAcademicRecords(api, endpoint) {
  const rows = [];
  for (let page = 1; page <= 100; page += 1) {
    const response = await api.get(`${endpoint}?limit=100&page=${page}`, { cache: "no-store" });
    const batch = rowsFrom(response);
    rows.push(...batch);
    if (batch.length < 100 || (response.meta && rows.length >= response.meta.total)) return rows;
  }
  throw new Error("More than 10,000 records. Use a scoped query before continuing.");
}

export async function fetchAcademicPage(api, endpoint, page, search, limit = 25) {
  const params = new URLSearchParams({ limit: String(limit), page: String(page) });
  if (search) params.set("search", search);
  const response = await api.get(`${endpoint}?${params.toString()}`, { cache: "no-store" });
  const rows = rowsFrom(response);
  return { rows, total: Number(response && response.meta && response.meta.total) || rows.length };
}
