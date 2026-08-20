# 05a. Cursor で phase を実行できるようにする

**リポジトリ:** ワークスペースルート（`funkot-player` ではない） / **依存:** なし

これは準備フェーズ群（05a–05e）のうち、ラベリングの中身に触れない唯一のもの。
作業環境の整備であり、他の準備フェーズと並行してよい。

## 目的

Cursor でも `.claude/plan-phases/<slug>/` の phase ファイルを、Claude Code と同じ規則で
実行できるようにする。

いまワークスペースルートの `.cursor/rules/` には `agent-delegation` /
`docs-skip-ci-commit` / `handoff` / `proactive-commit` / `subagent-model-cost` があり、
`.cursor/agents/` には designer / implementer / reviewer / fast-worker が揃っている。
**欠けているのは phase 実行規則そのもの。** Cursor はフェーズファイルを読んでも、
1つ終わったら次へ連鎖しないという規則を持たないので、指示範囲を超えて走る。

## 対象範囲

ワークスペースルート（`funkot-player` と `funkot-autodj-for-ui` の**両方を直下に持つ
最初のディレクトリ**。`~/.claude/rules/funkot-workspace-root.md` の手順で辿って決める。
推測しない）に、2ファイルを新規作成する。

### (a) `.cursor/rules/phased-plan-execution.mdc`

frontmatter:

```
---
description: フェーズ分割プランは原則1ファイルずつ。ユーザーが連続実行を明示したときだけ連鎖する。
alwaysApply: true
---
```

本文は `.claude/rules/phased-plan-execution.md` の **実行規則3項のみ**を移す
（名指しされた時だけ扱う／原則連鎖しない／完了時に README.md を更新する）。

**「Plan Mode での生成（Claude 専用。コピーしない）」節は入れない。** EnterPlanMode は
Claude Code のハーネス機能であり、Cursor には対応物が無い。入れると Cursor は
実行できない手順を実行しようとする。

「同じ方針の本文」のポインタ行は、このワークスペースの実配置に合わせて書く
（Claude 側は `.claude/rules/phased-plan-execution.md`）。

### (b) `.cursor/rules/funkot-workspace-root.mdc`

frontmatter:

```
---
description: funkot の作業ツリーはワークスペースルート直下から選ぶ。入れ子 git は git -C を使う。
alwaysApply: true
---
```

本文は `~/.claude/rules/funkot-workspace-root.md` から次の2点を移す:

- 作業ツリーの決め方（cwd から親へ辿り、`funkot-player` と `funkot-autodj-for-ui` の
  両方を直下に持つ最初のディレクトリ。`~/Projects/funkot-*` は旧配置で書き込まない）
- 入れ子 git（3リポジトリはそれぞれ `.git` を持つ。`git -C <path>` を使う。cwd 頼みに
  するとワークスペースルート側の repo を操作しうる）

Cursor は Composer / Grok へ委譲する。**委譲先が cwd を頼りに git を叩くと、
子リポジトリのつもりでルート repo を触る。** この規則が無いと検出できない。

## 対象外

- `.claude/` 側の変更。Claude Code は既に両方の規則を持っている
- `agent-delegation` / `subagent-model-cost` の統合や相互コピー。
  `AGENT-SETUP.md`「Cursor との分離」のとおり frontmatter の `model` / `tools` は
  ツール固有であり、**片方を直してもう片方へコピーしない**
- `funkot-player` / `funkot-autodj-for-ui` リポジトリ内への `.cursor/` 新設。
  ルート `.gitignore` の冒頭コメントが「追跡するのは Projects/ 配下**全体**に効く
  Claude / Cursor の設定だけ」と定めている。子リポジトリに agent 設定は置かない
- Codex（`AGENTS.md`）への同内容の展開。このワークスペースには `AGENTS.md` が無く、
  新設は別の判断。**やらない**

## 関連ファイル

| パス | 役割 |
|---|---|
| `.claude/rules/phased-plan-execution.md` | 移す本文の出どころ（実行規則3項） |
| `~/.claude/rules/funkot-workspace-root.md` | 移す本文の出どころ（作業ツリー・入れ子 git） |
| `.cursor/rules/*.mdc` | 既存4本。frontmatter の書式をここに合わせる |
| `AGENT-SETUP.md` | 「Cursor との分離（必須）」節。置き場の正本 |
| `.gitignore`（ルート） | ホワイトリスト方式。`!/.cursor/` で追跡済み |

## 制約・不変条件

- **既存の `.cursor/rules/*.mdc` を書き換えない。** 追加だけ
- 2ファイルとも `alwaysApply: true`
- `.mdc` の frontmatter は既存4本と同じ書式（`description` と `alwaysApply` の2キー）
- ワークスペースルートは追跡対象なので、**この変更は commit する**
  （`git -C <workspace-root>`）。子リポジトリは触らない

## 受け入れ条件

1. `.cursor/rules/phased-plan-execution.mdc` と `.cursor/rules/funkot-workspace-root.mdc`
   が存在する
2. 両ファイルの frontmatter に `alwaysApply: true` がある
3. `phased-plan-execution.mdc` に **Plan Mode / EnterPlanMode / ExitPlanMode の語が
   1つも含まれない**
4. `phased-plan-execution.mdc` が実行規則3項をすべて含む
5. `funkot-workspace-root.mdc` に `git -C` が含まれる
6. `git -C <workspace-root> status --short` に、この2ファイル以外の差分が出ない

## 検証コマンド

```bash
# ワークスペースルートで実行
cd "$(pwd)"   # funkot-player と funkot-autodj-for-ui を直下に持つディレクトリ

ls .cursor/rules/
grep -c 'alwaysApply: true' .cursor/rules/phased-plan-execution.mdc .cursor/rules/funkot-workspace-root.mdc
grep -ci 'plan mode\|EnterPlanMode\|ExitPlanMode' .cursor/rules/phased-plan-execution.mdc   # 0 であること
grep -c 'git -C' .cursor/rules/funkot-workspace-root.mdc
git status --short
```

## 報告形式

1. **変更したファイル** — パスと、各ファイルで何をしたか1行ずつ
2. **実装内容** — 何を移し、何を落としたか。特に Plan Mode 節を落とした箇所
3. **実行したコマンド** — 上記検証コマンドの実コマンド
4. **テストおよび検証結果** — 出力を貼る。特に受け入れ条件3の `0`
5. **仮定した事項** — 仕様に無く自分で決めた箇所（無ければ「なし」）
6. **未解決事項と残存リスク** — Cursor 側で実際に読まれたかの確認は人にしかできない旨を含む
