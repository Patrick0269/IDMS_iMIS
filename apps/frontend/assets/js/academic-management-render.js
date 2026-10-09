export function renderAcademicTable(table, template, options) {
  const { rows, columns, selectable, state, section, canManage, departmentFor, appendCellValue, emptyMessage } = options;
  table.replaceChildren();
  const head = table.createTHead().insertRow();
  if (selectable) {
    const th = document.createElement("th");
    const selectPage = document.createElement("input");
    selectPage.type = "checkbox";
    selectPage.id = "amxSelectPage";
    selectPage.setAttribute("aria-label", "Select this page");
    th.appendChild(selectPage);
    head.appendChild(th);
  }
  columns.forEach((column) => {
    const th = document.createElement("th");
    th.scope = "col";
    th.textContent = column[0];
    head.appendChild(th);
  });
  ["Department / Section", "Actions"].forEach((label) => {
    const th = document.createElement("th");
    th.scope = "col";
    th.textContent = label;
    head.appendChild(th);
  });
  const body = table.createTBody();
  rows.forEach((row) => {
    const tr = template.content.firstElementChild.cloneNode(true);
    let cell;
    const department = departmentFor(section, row);
    if (selectable) {
      cell = tr.insertCell();
      cell.dataset.label = "Select";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.dataset.selectCourse = row.id;
      checkbox.checked = state.selected.has(row.id);
      checkbox.setAttribute("aria-label", `Select ${row.course_code || "course"}`);
      cell.appendChild(checkbox);
    }
    columns.forEach((column) => {
      cell = tr.insertCell();
      cell.dataset.label = column[0];
      appendCellValue(cell, row[column[1]], column[2]);
    });
    cell = tr.insertCell();
    cell.dataset.label = "Department / Section";
    cell.textContent = department.department_name || "Shared / unassigned";
    const group = document.createElement("small");
    group.textContent = department.academic_group || "Not assigned";
    cell.append(document.createElement("br"), group);
    cell = tr.insertCell();
    cell.dataset.label = "Actions";
    if (canManage() && section !== "curriculumCourses") {
      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "amx-btn";
      edit.dataset.edit = row.id;
      edit.textContent = "Edit";
      cell.appendChild(edit);
    }
    if (canManage() && section === "courses") {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "amx-btn amx-danger";
      remove.dataset.amxDelete = row.id;
      remove.textContent = "Delete";
      cell.appendChild(remove);
    }
    if (!canManage()) cell.textContent = "Read only";
    body.appendChild(tr);
  });
  if (!rows.length) {
    const row = body.insertRow();
    const empty = row.insertCell();
    empty.colSpan = columns.length + 2 + (selectable ? 1 : 0);
    empty.className = "amx-empty";
    empty.textContent = emptyMessage;
  }
}
