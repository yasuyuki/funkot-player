(() => {
  const count = document.querySelector("#count");
  const menu = document.createElement("details");
  menu.className = "list-tools";
  count.replaceWith(menu);
  const toggle = document.createElement("summary");
  toggle.title = "一覧の操作";
  toggle.setAttribute("aria-label", "一覧の操作と並び順");
  toggle.append(count);
  const panel = document.createElement("div");
  panel.className = "tools-panel";
  panel.innerHTML = '<label>並び順<select><option value="added">新しく追加した順</option><option value="title">曲名順</option><option value="artist">アーティスト順</option><option value="year">制作年が新しい順</option><option value="plays">よく聴いた順</option></select></label><button type="button">複数の曲を選ぶ</button>';
  menu.append(toggle, panel);
  document.querySelector(".list-header").append(menu);
  const bar = document.createElement("div");
  bar.className = "selection-bar";
  bar.hidden = true;
  bar.innerHTML = '<span role="status"></span><button type="button">選んだ曲を追加</button><button type="button">終了</button>';
  document.querySelector("#rows").before(bar);
  const [add, close] = bar.querySelectorAll("button");
  const selected = new Set();
  let selecting = false;
  const sort = panel.querySelector("select");
  const comparators = {
    title: (a,b) => a.title.localeCompare(b.title,"ja"),
    artist: (a,b) => a.artist.localeCompare(b.artist,"ja"),
    year: (a,b) => (b.year ?? 0) - (a.year ?? 0),
    plays: (a,b) => b.plays-a.plays,
  };
  function sync() {
    const dest = FK.playlists.find(p => p.id === window.FKS?.getDestinationId());
    const destination = dest?.name ?? document.querySelector("#destinationName").textContent;
    const visible = new Set(window.FKS?.getFilteredSongIds() ?? []);
    for (const id of selected) if (!visible.has(id)) selected.delete(id);
    bar.firstElementChild.textContent = selected.size + " 曲を選択";
    add.textContent = destination + "に追加";
    add.disabled = !selected.size;
    for (const row of document.querySelectorAll("#rows .row")) {
      const track = row.querySelector(".track");
      if (!track) continue;
      if (selecting) track.setAttribute("aria-pressed", String(selected.has(Number(row.dataset.songId))));
      else track.removeAttribute("aria-pressed");
    }
  }
  function selection(on) {
    selecting = on;
    bar.hidden = !on;
    menu.open = false;
    selected.clear();
    sync();
    (on ? document.querySelector("#rows .track") : toggle)?.focus();
  }
  sort.onchange = () => { menu.open = false; window.FKS.render(); toggle.focus(); };
  panel.querySelector("button").onclick = () => selection(true);
  close.onclick = () => selection(false);
  add.onclick = () => { window.FKS.addMany([...selected]); selection(false); };
  document.querySelector("#rows").addEventListener("click", event => {
    const track = event.target.closest(".track");
    if (!selecting || !track) return;
    event.stopImmediatePropagation();
    const row = track.closest(".row");
    const id = Number(row.dataset.songId);
    if (!Number.isFinite(id) || row.querySelector(".add")?.disabled) return;
    if (selected.has(id)) selected.delete(id);
    else selected.add(id);
    sync();
  }, true);
  document.addEventListener("keydown", e => {
    if (e.key !== "Escape") return;
    if (menu.open) { menu.open = false; toggle.focus(); }
    else if (selecting) selection(false);
  });
  document.addEventListener("click", e => {
    if (menu.open && !menu.contains(e.target)) menu.open = false;
  });
  window.sleeveTools = {
    order(list) {
      const compare = comparators[sort.value];
      return compare ? list.slice().sort(compare) : list;
    },
    rowsRendered() { if (selecting) sync(); }
  };
})();
(() => {
  const dialog = document.getElementById("collectionView");
  const select = document.getElementById("collectionSelect");
  const songById = new Map(FK.songs.map(song => [song.id, song]));
  const title = document.getElementById("collectionTitle");
  for (const list of FK.playlists) select.add(new Option(list.name, list.id));
  function draw(id) {
    const list = FK.playlists.find(p => p.id === id);
    const ids = FKS.getCollectionIds(id);
    title.textContent = list.name;
    document.getElementById("collectionCount").textContent = ids.length ? ids.length + " 曲" : "まだ曲がありません。ライブラリの ＋ から追加できます。";
    const rows = document.getElementById("collectionRows");
    rows.replaceChildren();
    for (const songId of ids) {
      const item = document.createElement("li");
      const song = songById.get(songId);
      const artist = document.createElement("small");
      artist.textContent = song.artist || "アーティスト未登録";
      item.append(song.title, artist);
      rows.append(item);
    }
  }
  select.onchange = () => draw(select.value);
  for (const link of document.querySelectorAll(".masthead nav a")) link.onclick = e => {
    e.preventDefault();
    const queue = link.hash === "#queue";
    select.hidden = queue;
    const dest = FKS.getDestinationId();
    select.value = dest;
    draw(queue ? "queue" : select.value);
    dialog.showModal();
  };
})();
