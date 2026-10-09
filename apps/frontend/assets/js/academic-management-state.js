export function createAcademicState() {
  return {
    lookups: {},
    active: "courses",
    courseView: "all",
    selected: new Set(),
    page: 1,
    search: "",
    user: null,
    visibleRows: [],
    ready: false,
    importRows: [],
    importValid: false,
    serverRows: [],
    serverTotal: 0,
    serverQueryKey: "",
    serverRequestKey: ""
  };
}
