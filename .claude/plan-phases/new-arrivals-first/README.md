# new-arrivals-first — 新規追加された曲を優先して再生する

新しく Music フォルダへ入れた曲は自動選曲に埋もれてなかなか鳴らない。folder track 一覧は
Start 時のスナップショットで固定され再起動まで更新されないため、起動中に増えた曲へ到達する
経路は pending queue しかない。ファイル監視も無く、新着を検知できるのは refresh が走る時だけ。

ゴール: 新着を確実に検出して目立つ形で提示し、**明示操作**でまとめてキュー先頭へ入れる。

## フェーズと順序

後段は前段の完了を前提条件とする。独立には実行できない。

1. `phase-01-first-seen-index.md` — 検出の土台（index・Settings・lock・原子的保存）
2. `phase-02-queue-new-tracks.md` — 抽出・消し込み・キュー投入（phase-01 が前提）
3. `phase-03-ui-new-arrivals.md` — 表示と操作（phase-01 / 02 が前提）

## 決定事項

**検出**

1. 新着 = `hash-index.json` の first-seen marker あり **かつ** `history.json` に記録なし。
2. hash index の load に **provenance**（Loaded / Missing / Corrupt）を持たせる。現状は missing も
   corrupt も空 map で、正常な空 index と区別できない。baseline 済みかは `settings.json` の
   arrivals baseline flag（既定 false）。
   - done かつ Loaded（**空でも**）→ 通常 scan。index に無い path を stamp
   - done かつ Missing / Corrupt → 復旧 baseline。stamp せず warn
   - not done → 初回または Music フォルダ変更後の baseline

   これで「空ライブラリを baseline → 後日 1 曲追加」が NEW になる。**復旧 baseline が
   incomplete scan だった場合**、partial index を保存して done=true を残すと次回は
   Loaded(partial) になり、前回見えなかった既存 path の復旧が偽 NEW になる。よって —
   incomplete なら再構築した index を**保存しない** / provenance を Missing / Corrupt のまま
   維持する / 新着抽出は not done に加え Missing / Corrupt でも**空を返す** / **complete scan の
   時だけ**全 marker が None の index を保存して復旧を完了する。
3. **scan completeness**: 現行の scan は entry error・file type error・読めない subdirectory を
   skip して継続する。SMB の一時障害で旧 entry が prune され、復旧時に新規 path として stamp
   されると**偽 NEW** になる。scan に complete を持たせ、不完全な scan では**全体 prune を
   行わない**。
4. 同一 path の内容差し替え: hash 同一なら marker を保持（legacy None も None のまま＝以前から
   在る）/ hash 変更は新 identity として stamp / tags cache 補完だけでは変えない。content hash
   と library file の resolver は fingerprint miss で entry を丸ごと置換するので **carry
   forward** の改修が要る。「None を一括 stamp」は禁止。
5. **baseline mode では scan 対象 entry の marker を明示的に全て None にする**。「stamp しない」
   だけでは、親フォルダへの変更や同一フォルダの再選択で旧 path が重なり marker が carry される。
   baseline flag が false の間、新着抽出は**空を返す**（baseline refresh 前の旧 index を
   見せない）。
6. Music フォルダ変更で baseline を倒すのは **実 path が変わった時だけ**。フォルダ設定 command の
   changed: true は「選択が確定した」であって「前と違う」ではない（同じフォルダを選び直しても
   true）。lock 内で Settings の music dir を再ロードして比較する。

**消し込みと fold**

7. 「再生すれば自動で外れるので書き込み不要」は撤回。全体 fold も不可（新着 A / B のうち A だけ
   再生すると B が残って集合が空にならず、未再生が 1 件残る限り累積する）。正しくは **history に
   hash が存在する entry だけを個別に None へ fold** する。同一 pull 内でまとめれば index 保存は
   最大 1 回。書く対象が無ければ write しない。
8. **履歴消去 command は消去前 history で fold してから消す。** 現状は保存 lock を取って history を
   直接空にするため、「再生 → revision 増 → フロントが pull する前に履歴消去」で再生済み曲が
   NEW に復活する。順序を index lock → 保存 lock → history を読む → 該当 entry を None →
   index 保存 → **成功した時だけ** history 消去、とする。index 保存に失敗したまま history を
   先に消すと played の証拠を永久に失うので、その場合は **command を失敗させ history を残す**。
9. **fold の保存失敗は warn-only にしない。** 新着抽出が played entry を結果から外した後に marker
   保存だけ失敗すると、後の履歴消去で復活する。失敗を返し、フロントはその history revision を
   適用済みにせず、次の poll で同じ revision の reconciliation を再試行し、stale response で
   前回の表示を上書きしない。

**同期**

10. 解除は pull だが、**トリガは now playing ではなく history revision**。events thread は
    NOW 更新 → sync state → session 保存 → 再生記録 → history 保存の順で、player state は
    history 保存前でも新しい now playing を返せる。その瞬間の pull は古い history を読み、以後
    now playing は変わらないので NEW が残る。query 側で保存 lock を取っても、query が先に lock を
    取る順序は防げない。→ **history 保存成功後に history revision を増やし、player state に
    history revision を足し、フロントは revision 変化で pull する**。同一 path の再スタートでも
    同期する。並行 pull には既存の queue generation guard と同型の arrivals generation guard を
    置く。
11. 再生記録は events thread から呼ばれ app handle を持たないので push は採らない（新しい静的
    handle が要る）。pull が読むのは **settings.json + hash-index.json + history.json の
    app-data JSON のみで、Music ファイル I/O なし**（既存の index-only パターンと同じ）。
    settings.json を含むのは決定事項 5 の baseline flag を見るため。サーバが content hash で
    解決するので同内容ファイルが同時に消える。

**排他と耐久性**

12. hash index 保存の tmp + rename は torn JSON を防ぐが **writer 間の lost update は防がない**。
    refresh（compare / stamp / prune / save）、新着抽出の fold / save、baseline reset、履歴消去時の
    fold は、いずれも index の read-modify-write なので、**専用の index lock で load–mutate–save
    全体を直列化**する。長い scan の間 保存 lock を保持すると queue / history 保存が止まるため
    別 lock にする。
    - **固定順序は index lock → 保存 lock → session → queue → render。** 保存 lock の doc comment と
      queue 側の lock 順序 doc を更新する
    - **hash index の load 内部で lock を取らない。** ラベル設定や履歴消去は先に保存 lock を取る
      ため、暗黙 lock は逆順を作りやすい。orchestration 層で取る
    - tmp は同一ディレクトリに置き、writer 排他または一意名、失敗時 cleanup を行う
    - **Settings 保存も同じ理由で原子化する。** writer を直列化しても platform dirs / start /
      preload / 両 getter は lock-free reader で、現在の書き込みは truncate と書き込みの途中を
      読まれて破損扱い＝既定値へ落ちうる
13. **Settings の lost update を防ぐ。** Settings 保存は全フィールドをまとめて上書きし、現行
    writer は music dir / allow non funkot / labeling mode の 3 つで、どれも保存 lock を取って
    いない。refresh と music dir 設定だけを直列化すると、長い scan 中に他の 2 つが保存した値を
    refresh の古い Settings が巻き戻す（逆順なら baseline flag が false に戻る）。契約を次まで
    広げる。
    - **全 Settings read-modify-write を保存 lock で直列化する**
    - refresh と music dir 設定は index lock → 保存 lock
    - **refresh は index lock を取得した後に dirs 解決と Settings / music dir の snapshot を行い、
      その snapshot に対応する index / settings の commit が終わるまで保持する。**
      「index → 保存」だけでは、旧フォルダを解決してから lock を取るまでの間に music dir 設定が
      割り込み、旧フォルダの結果を index へ保存する競合が残る
    - refresh は **commit 時に Settings を再ロードし baseline flag だけを更新する**。scan 中ずっと
      保存 lock を保持する必要はない
    - allow non funkot / labeling mode の setter も保存 lock 内で再ロード・保存する
    - allow non funkot の静的フラグ store は保存成功後、保存 lock を解放する前に行う
    - music dir 設定は **folder picker を閉じた後**に lock を取り、lock 内で Settings を再ロード
      して実 path 比較・新 path・baseline false を保存する。**picker を開いている間は lock を
      保持しない**

    役割分担は index lock = index / baseline transaction、保存 lock = 短い Settings RMW。
14. baseline flag の true は **complete scan と index 保存の両方が成功した後だけ**保存する。
    新着抽出は **committed index だけを正本**にする（未保存 stamp は自然に結果へ出ない）。
    **この保存失敗を warn-only にしない**: index 保存後でも Settings 保存に失敗したら refresh は
    失敗を返し、成功した rows / 新着としてフロントへ反映せず、少なくとも同一プロセスでは
    refresh-owed / retry の対象にする。2 ファイルにまたがる crash-atomic transaction までは
    要求しないが、I/O エラーを成功扱いにはしない。
15. フロントの music dir 設定処理は refresh の結果を捨てているので、library busy に弾かれると
    新フォルダの baseline scan が永久に走らない。既存の import refresh-owed と同型の
    refresh-owed を記録し、busy 解消後に必ず走らせる。**owed は error でも維持する。** 現行の
    owed は busy 判定でのみ維持され通常 error では消える。契約を — 起動時 / Music フォルダ変更後 /
    Android 取り込み後の自動 refresh は **busy または error なら owed を維持** / **成功した
    refresh だけが owed を解除** / 新着の pull も成功まで processed revision・dirty 状態を
    進めない / **stale generation response を破棄しても owed は解除しない** — とする。

**操作と順序**

16. 自動キュー投入はしない。**明示操作のみ**。設定項目は作らない。常設バナー ＋ 行の NEW バッジ
    ＋ 新着のみフィルタ。トースト枠は 1 つしかないので、スキャン完了時の新着トーストは追加しない。
17. 順序不変条件は reserved があればその後ろに新着候補、その後ろに既存 pending。reserved に
    触れないので too late の失敗経路が無い。表示 index 1 は reserved がある時だけで、無ければ 0。
    新着候補の順序は **first-seen 昇順、同時刻は path 順**。
18. 判定と挿入は **一つの queue lock 内**で行う。snapshot を取ってから別途 prepend すると間の
    enqueue と競合する。同 lock 内で ① reserved / pending の既存集合を作る ② candidates を除外
    ③ 順序を保って pending 先頭へ挿入 ④ **実追加数を返す**。再生中の曲（reserved ではない）も
    サーバ側候補から除外する。gate は enqueue と同じ allow non funkot。command は実行時に
    index / history / gate / queue を再評価し、実追加数がフロントの正本。
    **queue 永続化の保存 lock 再入を禁止する。** queue 永続化は内部で保存 lock → queue を取り、
    Rust の Mutex は再入可能でないので、index lock → 保存 lock → queue を保持したまま呼ぶと
    deadlock する。判定と挿入をその guard 内で行い、**挿入後に queue / 保存 lock / index lock の
    全 guard を解放してから**既存の永続化関数を呼ぶ。
19. **library row に first-seen フィールドを作らない。** すべての表示を新着抽出の結果から導くなら
    二重管理であり、ラベル設定 / bars 設定 / 解析進捗 row による field 消失問題がそもそも消える。
    command は path と first-seen の組の配列を返し、フロントが path で library row と join する。
20. getter は 3 本。バッジ・フィルタ用（gate 非依存）/ gate 適用 / **gate 適用 ＋ 再生中・
    reserved・pending を除外**。バナーの操作件数は 3 番目。再生中も外すのは、revision が反映
    されるまで再生中の曲が件数へ一瞬戻るため。

## 留意点

- **stalled の正確な経路**: refresh は 6 経路から呼ばれる — 起動時（解析キックあり）、⋮再スキャン
  （あり）、Android 取り込み後（あり）、Music フォルダ変更後（あり）、解析完了後の quiet reload
  （**なし**）、履歴消去後（**なし**）。stamping は refresh に置くので解析キックによらず一律に
  かかる。一方「未解析でも裏解析が走るので待てばよい」はキック無しの 2 経路では成立しない。
  未解析の新着を即キューへ入れると loader が同期解析して stalled になりうる。ボタンは無効化せず、
  この事実を doc comment に残す。
- 一度も再生されない新着（gate で除外され続ける等）は fold されない。決定事項 7・8 により
  それ以外は累積しない。
- `history.json` は content hash キー。中身が同一の 2 ファイルは片方の再生で両方が既再生になる。
  既存仕様であり本件では変えない（決定事項 11 の同時解除はこれに乗っている）。
- `hash-index.json` は feedback ZIP に含まれない（ZIP は library / flags / meta のみ）ので、
  スキーマ変更の外部影響はない。

## 文書規約

- コード引用は行番号ではなくシンボル名を使う。行番号は腐る
- **未実装の予定シンボルや未作成ファイルを、シンボル名と path を組にした引用形式で書かない。**
  `scripts/check-doc-claims.sh` は `.claude/plan-phases` 配下を全走査するので、phase-01 完了
  時点で phase-02 / 03 の未実装引用が失敗する。予定のものは平文で書く
