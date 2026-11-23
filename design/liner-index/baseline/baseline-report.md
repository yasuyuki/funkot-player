# #173 Overprint Liner ベースライン

固定コミット `b8b5b15d5800e44f49e78ec4bf40309a94ed443a` の `library-general-claude` を、合成データだけで実測した。Playwright 1.63.0 と Edge 157.0.4341.46 を使用し、device scale factor は 1 である。画像は CSS viewport と同じピクセル寸法である。

## 実キャプチャ

- desktop 1280×900: `desktop-{base,a,a-edit,a-detail,tag-draft,a-select,eight,eight-edit,error}.png`
- narrow/touch 412×915: `narrow-{base,a,a-edit,a-detail,tag-draft,a-select,eight,eight-edit,error}.png`

全18枚の寸法とバイト数は `baseline-metrics.json` にある。両 viewport ともブラウザエラーは 0 件だった。

## 実測した流れ

|項目|desktop|narrow/touch|
|---|---:|---:|
|検索を開いた直後のフォーカス|`finderInput`|`lensInput`|
|`2015` 入力時の候補|4|4|
|`日本人` 入力時の候補|7|7|
|`anison` 入力時の候補|2|2|
|3条件 AND の結果画面に見える操作|35|32|
|3条件 AND の条件要約の高さ|40 px|48 px|
|結果の先頭行の上端|218 px|210 px|
|詳細を開いた後の結果スクロール高さ|4,093 px|4,386 px|

入力した候補から年・カスタムタグ・ジャンルを1つずつ選ぶと、両 viewport で3条件 AND になった。詳細は行を1回押して展開する。タグ編集は詳細の「タグを編集」から入力欄へフォーカスし、Enter の試行は「タグを加えました（試作のため保存しません）」と表示した。

## 階層・選択肢・スクロール

- 3条件の編集面は desktop では一覧を残す非全画面の面で、結果領域は 266 px。narrow では全 viewport を覆う面である。編集時の可視操作はそれぞれ 82 と 85。
- 9条件状態は一行要約に畳まれる。要約の高さは desktop 40 px、narrow 48 px。`eight-edit` はすべての管理項目を開き、可視操作は desktop 94、narrow 89。desktop は一覧を背後に残し、narrow は全画面シートになる。
- 詳細展開で結果のスクロール高さは、3条件結果から desktop で 3,832 → 4,093 px、narrow で 3,933 → 4,386 px になった。技術情報とタグ入力は詳細内をスクロールして読む配置である。
- 行クリック後と条件編集を Escape で閉じた後は、この実測ではアクティブ要素が `body` だった。検索を開く時とタグ入力を開く時のフォーカスは確認できたが、復帰先のフォーカス保持はこの基準では確認できない。

## 基準に存在しない機能

- 明示的なタグ Save / Cancel、未保存変更の表示、失敗後の下書き保持、`stale_revision` / `identity_changed` の再読込・再確認はない。
- 年の自動/手動/未設定の切替、埋め込み由来と手動由来の編集区別、タグの削除、複数曲のタグ一括編集はない。`a-select` の一括選択は追加先への追加だけである。
- `error` は検索結果の「前回の結果」表示を示す状態であり、タグ保存の競合復旧ではない。
- 本試作は合成データをメモリ内で変更するだけで、音声ファイル、永続化、Native/WebView2、実機ソフトキーボード、実スクリーンリーダーは未検証である。

## 再生成

`capture-baseline.mjs` はこのディレクトリから Playwright package directory を引数に受け、同じ画像と `baseline-metrics.json` を作り直す。生成物にはローカル絶対パス、実データ、認証情報を含めない。
