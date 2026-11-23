(() => {
  const sheet = document.getElementById("detailSheet");
  const escape = value => String(value).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  function updateTags(song, next) {
    for (const tag of new Set([...song.tags, ...next])) {
      const key = "custom:" + tag;
      const entry = FK.tagIndex.get(key) ?? {key,kind:"custom",value:tag,count:0};
      entry.count += Number(next.includes(tag)) - Number(song.tags.includes(tag));
      FK.tagIndex.set(key,entry);
    }
    song.tags = next;
  }
  window.showSleeveDetail = function(song,onClose,onSave) {
    const wasOpen = sheet.open;
    sheet.hidden = false;
    const duration = Math.floor(song.dur/60) + ":" + String(song.dur%60).padStart(2,"0");
    sheet.innerHTML = '<button class="detail-close" type="button">閉じる</button><small class="detail-kicker">曲の詳細</small><h2 id="detailTitle"></h2><p class="detail-meta"></p><dl class="track-facts"></dl><details class="edit-tags"><summary>タグを編集</summary><label>タグ（カンマ区切り）<input id="tagEdit"></label><button type="button" id="saveTags">保存</button></details><span role="status" class="tag-feedback"></span>';
    sheet.querySelector("h2").textContent = song.title;
    sheet.querySelector(".detail-meta").textContent = song.artist || "アーティスト未登録";
    const facts = [
      ["制作年",song.year ?? "未登録"],["ファイル",song.fmt + " · " + duration],
      ["ジャンル",song.genres.join("、") || "未登録"],["タグ",song.tags.join("、") || "未登録"],
      ["保存場所",song.folder],["再生回数",String(song.plays)]
    ];
    if (song.missing) facts.push(["ファイルの状態","見つかりません"]);
    sheet.querySelector("dl").innerHTML = facts.map(([name,value]) => "<dt>"+escape(name)+"</dt><dd>"+escape(value)+"</dd>").join("");
    const edit = sheet.querySelector("#tagEdit");
    edit.value = song.tags.join(", ");
    sheet.querySelector("#saveTags").onclick = () => {
      updateTags(song,[...new Set(edit.value.split(/[,、]/).map(t=>t.trim()).filter(Boolean))]);
      onSave();
      window.showSleeveDetail(song,onClose,onSave);
      sheet.querySelector(".tag-feedback").textContent = "タグを保存しました";
      sheet.querySelector(".edit-tags summary").focus();
    };
    sheet.querySelector(".detail-close").onclick = () => sheet.close();
    sheet.onclose = () => {sheet.hidden = true; onClose();};
    if (!wasOpen) { sheet.showModal(); sheet.querySelector(".detail-close").focus(); }
  };
})();
