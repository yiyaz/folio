/** Build a sortable, filterable HTML table (used for csv blocks, datasets and notebooks). */
export function sortableTable(headers: string[], rows: unknown[][], opts: { total?: number; caption?: string } = {}): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'data-table';
  const bar = document.createElement('div');
  bar.className = 'data-table-bar';
  const filter = document.createElement('input');
  filter.placeholder = 'Filter rows…';
  filter.className = 'data-table-filter';
  const info = document.createElement('span');
  info.className = 'muted';
  bar.append(filter, info);
  const scroller = document.createElement('div');
  scroller.className = 'data-table-scroll';
  const table = document.createElement('table');
  const thead = table.createTHead();
  const tbody = table.createTBody();
  let sortCol = -1;
  let sortDir = 1;
  let view = rows.slice();

  const hr = thead.insertRow();
  headers.forEach((h, i) => {
    const th = document.createElement('th');
    th.textContent = h;
    th.tabIndex = 0;
    th.title = 'Sort';
    const sort = () => {
      sortDir = sortCol === i ? -sortDir : 1;
      sortCol = i;
      for (const el of hr.children) el.removeAttribute('data-sort');
      th.dataset.sort = sortDir > 0 ? 'asc' : 'desc';
      render();
    };
    th.addEventListener('click', sort);
    th.addEventListener('keydown', (e) => e.key === 'Enter' && sort());
    hr.appendChild(th);
  });

  const cmp = (a: unknown, b: unknown) => {
    const na = Number(a);
    const nb = Number(b);
    if (a !== '' && b !== '' && !Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
    return String(a ?? '').localeCompare(String(b ?? ''));
  };

  function render() {
    const q = filter.value.trim().toLowerCase();
    view = q
      ? rows.filter((r) =>
          r.some((c) =>
            String(c ?? '')
              .toLowerCase()
              .includes(q),
          ),
        )
      : rows.slice();
    if (sortCol >= 0) view.sort((a, b) => cmp(a[sortCol], b[sortCol]) * sortDir);
    tbody.replaceChildren();
    for (const r of view.slice(0, 1000)) {
      const tr = tbody.insertRow();
      for (let i = 0; i < headers.length; i++) {
        const td = tr.insertCell();
        const v = r[i];
        td.textContent = v == null ? '' : typeof v === 'object' ? JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)) : String(v);
        if (typeof v === 'number' || typeof v === 'bigint') td.className = 'num';
      }
    }
    const total = opts.total ?? rows.length;
    info.textContent = `${view.length.toLocaleString()} of ${total.toLocaleString()} rows${view.length > 1000 ? ' (showing first 1,000)' : ''}${opts.caption ? ` · ${opts.caption}` : ''}`;
  }
  filter.addEventListener('input', render);
  render();
  scroller.appendChild(table);
  wrap.append(bar, scroller);
  return wrap;
}
