# gitignore 対象データの分類と再生成

ignore 対象は、消えたときのコストで分かれる。**保護するのは「再生成不可」だけ。**
残りは消してよい。消す前にこの表で確認する。

| クラス | 対象 | 扱い |
|---|---|---|
| 再生成可能 | `src-tauri/target/`、`src-tauri/gen/`、`node_modules/`、`dist/`、`packaging/msix/{out,staging}/` | 消してよい。ビルドで戻る |
| 外部から再取得 | `.desktop-data/Music/`（267MB、手で入れた試聴用トラック）、`testdata/funkot-rel-paths.txt` | 消してよい。音源ルートから入れ直す |
| 高コストな派生 | `testdata/*-shots/`（UI 確認のスクショ、計 27MB）、`testdata/funkot-transfer*.log`、`testdata/push_manifest_p10.txt` | 消してよい。smoke を流し直せば取れる |
| キャッシュ・ローカル状態 | `.desktop-data/{CacheStorage,WebKitCache,storage,logs,window.json,history.json,play-log.jsonl}`、`.win-run.stamp` | 消してよい |
| 手動編集を含む解析キャッシュ | `.desktop-data/funkot-cache/` | 自動解析だけとは限らない。下記の手動情報を確認して保全する |
| **再生成不可** | `HANDOFF.md`、`ISSUES.md`、data directory の `track-tags.json`、`playback-state.json`、移行元の `queue.json`・`session.json`・`playlists.json`・`settings.json` | **保全する。** `track-tags.json` は利用者が付けた制作年・タグ追加・自動タグの除外を content hash ごとに持つ。解析 cache の削除や再解析では再生成できない。破損・未知 schema のときは原本を上書きせず、タグ編集だけを停止して再生を続ける。 |
| 秘密 | `.secrets/upload-keystore.jks`、`src-tauri/gen/android/keystore.properties` | **リポジトリにもバックアップにも入れない。** 別途退避済み。`scripts/pack-signing-backup.sh` 参照 |

`track-tags.json` の編集中は同じ directory の `track-tags.lock` で複数 process の read-modify-write を直列化する。lockfile が残っている場合は、タグ編集を busy として止め、既存の再生を続ける。クラッシュ後の復旧では、同じ data directory を使う player process がすべて終了していることを確認してから、その lockfile だけを除去する。破損または未知 schema の JSON はその前に別の安全な場所へコピーし、元ファイルを置換しない。

正常な backup を復元するときも player を終了し、破損・未知 schema の原本を保全した後、backup の schema に対応する player で同じ data directory へ復元する。自動で空の JSON に置き換えない。今回タグの export/import 機能はなく、既存 feedback ZIP に `track-tags.json` を自動追加しない。共有範囲は別途判断する。

`playback-state.json` はキューの出現ID、再開中の曲、名前付きリストの構成・曲順・進行、設定を一つのスナップショットとして保存する。再生してもリスト構成は消えない。保存成功を返す編集は、このファイルの置換が終わっている。応答前のプロセス停止では、編集前または編集後のスナップショットが残る。電源喪失によるファイルシステムの metadata 消失まで保証するものではない。

直前世代の `queue.json`・`session.json`・`playlists.json`・`settings.json` から変換し、移行元の bytes は残す。旧キューと catalog 内の通常キューが食い違う場合は、新旧の順序を判定できないため自動変換しない。音源一覧は表示し、再生と曲順の編集を止め、回復画面で利用者が再開する曲順を選ぶ。選択した順序の新スナップショットを保存してから再生を許可し、両方の移行元を変更せずに残す。選択前に移行元が変わった場合や保存に失敗した場合は回復成功としない。新ファイルが存在したら移行元へ自動で戻らない。破損・未知 schema・読取不能は空の正常データへ置き換えず、保存・編集を制限する。これらのファイルを cache として削除しない。正常な backup を戻す場合は player を終了し、現在の原本を保全してから対応 schema の backup を同じ data directory に戻す。

`playlists.lock` は保存データを使う間、OS の排他 lock を保持する。同じ data directory を使う別 process の保存を防ぐ。process 終了で lock は解放されるため、lockfile の存在だけを異常と判断して削除しない。リスト名・曲名・path を含む保存スナップショットは feedback ZIP に含めない。

player の手動補正は data directory の `library.json` に保存し、解析 cache にも反映する。
`library.json`、ラベル、手動フラグを持つ cache を、再生成可能な自動解析だけとみなして
消さない。core の `purge_auto` は手動側を残して再解析待ちにする。cache 全削除で代用しない。
今回の検証は専用の使い捨てデータだけを使い、既存の手動データと hash-index は移行しない。

保存形式を非互換に改訂するときのサポート範囲は、
[互換性・データ変換方針](development-setup.md#compatibility-and-data-migration)のとおり、
直前のデータ形式世代から現在形式への前向き変換1世代だけです。
これは未対応・破損データや手動情報を削除する許可ではありません。
変換完了を確認するまで原本を回復可能に保全し、対象外は理由を示して上書きしません。
再生成可能な派生物の扱いと、手動タグ・補正・プレイリスト構成・曲順・進行や
通常キューの再開状態の保護を混同しません。音源の再取得可能性を、利用者の元音源や
埋込み metadata の削除・変更の許可へ広げません。

## 再生成

| 対象 | 手順 |
|---|---|
| `node_modules/` | `npm ci` |
| `src-tauri/target/`、`src-tauri/gen/` | 通常のビルド（`./dev.sh`） |
| `.desktop-data/Music/` | `GUI=1 ./dev.sh` で起動し、聴きたいトラックを入れる（`dev.sh` の該当コメント） |
| `testdata/funkot-rel-paths.txt` | 音源ルート `/mnt/oldpc/music` から相対パス一覧を作る。使い方は [`adb-music-transfer.md`](adb-music-transfer.md) |
| `testdata/*-shots/` | `scripts/smoke-cold-audition.sh <adb-addr>` / `scripts/smoke-tap-edit.sh <adb-addr>` |

## HANDOFF.md / ISSUES.md がなぜ守られないか

どちらも公開できないため ignore されている。foundation の release backup は
`git bundle create --all` で、**定義上 ignored ファイルを含まない**。promote 後の
release は clean clone なので、そこにも存在しない。

そのため実体はリリース系列の外の private store に置き、作業ツリーからは symlink で
参照する。新しい checkout ではそこから張り直すこと（手順は `HANDOFF.md`）。

## 新しく ignore を足すとき

置き場所で決める。**手で書いたスクリプトは `testdata/` に置かない。** `testdata/` は
実行の生データ（スクショ、ログ、生成された一覧）だけにして、スクリプトは `scripts/`、
残す知見は `docs/` へ置く。ignore の粒度を細かくするより置き場所を直す方が壊れにくい。
