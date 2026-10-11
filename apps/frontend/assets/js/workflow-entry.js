(function () {
  'use strict';

  async function start() {
    try {
      if (!window.IDMCAPI) return;

      const response = await window.IDMCAPI.get('/improvements/capabilities');
      const capabilities = response.data || response;
      const roles = capabilities.roles || [];
      const permissions = capabilities.permissions || [];
      const has = (permission) => permissions.includes(permission);
      const lecturer = roles.includes('LECTURER') && !roles.some((role) => [
        'ADMIN', 'SUPER_ADMIN', 'HOD', 'ACADEMIC_OFFICER', 'EXAMINATION_OFFICER', 'EXAM_OFFICER'
      ].includes(role));
      const page = location.pathname.split('/').pop();
      const area = document.body.dataset.workspace || page.replace('.html', '');

      // Keep each operation on its existing form. The API remains the authority for
      // role checks, so this shared script must not hide actions or redirect users.

      // Contextual print belongs in the page's action row, not in a global shortcut card.
      const mayPrint = area === 'timetable'
        ? has('timetable.view') || has('timetable.manage')
        : area === 'attendance' && (has('attendance.view') || has('attendance.manage') || lecturer);
      function addContextPrint() {
        const actions = document.querySelector('#contextActions');
        if (!mayPrint || !actions || actions.querySelector('[data-context-print]')) return;
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.contextPrint = 'true';
        button.textContent = area === 'timetable' ? 'Print timetable' : 'Print attendance';
        button.className = 'btn';
        button.addEventListener('click', () => {
          const table = document.querySelector('#resourceTable');
          if (!table || !table.querySelector('tbody tr')) return;
          const frame = document.createElement('iframe');
          frame.title = 'Print preview';
          frame.style.cssText = 'position:fixed;width:0;height:0;border:0;left:-9999px';
          document.body.append(frame);
          const title = area === 'timetable' ? 'Teaching timetable' : 'Student attendance';
          frame.contentDocument.open();
          frame.contentDocument.write('<!doctype html><html><head><meta charset="utf-8"><title>' + title + '</title><style>body{font:12px Arial,sans-serif;color:#222}h1{font-size:18px}table{width:100%;border-collapse:collapse}td,th{border:1px solid #999;padding:7px;text-align:left}button{display:none}@media print{body{margin:12mm}}</style></head><body><h1>IDMS iMIS · ' + title + '</h1>' + table.outerHTML + '</body></html>');
          frame.contentDocument.close();
          window.setTimeout(() => {
            frame.contentWindow.focus();
            frame.contentWindow.print();
            window.setTimeout(() => frame.remove(), 60000);
          }, 200);
        });
        actions.append(button);
      }
      addContextPrint();
      const actionRow = document.querySelector('#contextActions');
      if (mayPrint && actionRow) {
        new MutationObserver(addContextPrint).observe(actionRow, { childList: true });
      }
    } catch (error) {
      console.error('Workflow controls:', error.message);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
