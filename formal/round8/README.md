# Round 8 — ノートのライフサイクル（ロード→ログイン→描画→編集→自動保存）を TLA+ で検証

`app/components/useNoteEditor.ts` の自動保存・ナビゲーションガードと、
`app/pages/Notes/Edit.tsx`（ログイン状態はサーバ側で解決し props で渡る）を
状態遷移システムとしてモデル化し、TLC で検査した記録。非同期・並行・時間発展を
含むので **TLA+** が適任。

## モデル（`tla/Autosave.tla`）

```
phase:        loading → guest | editing     （ログイン状態の解決。noteIdの有無）
konvaReady:   描画完了
modelVer:     編集で増える現在のモデル版
lastSaved:    lastSavedContentRef（クライアントが「保存済み」と信じる版）
serverLatest: 実際に永続化された版（リクエスト送出順で適用する楽観モデル）
timer:        デバウンスタイマ（編集で1500ms再アーム）
inflight:     送信中のPUTの版の集合（並行保存を表現）
```

要点は**編集が in-flight 保存中に入ると保存が並行**し、レスポンスが**順不同**で
返りうること。`lastSavedContentRef` は完了順に上書きされ**版ガードが無い**。

## 検証結果（`MaxVer=2`）

### 成立した安全性（`Autosave.cfg` → No error）

| 不変条件 | 保証する性質 |
|---|---|
| `GuestNeverSaves` | ゲスト（noteId無し）は**ネットワーク書き込みを一切しない** |
| `NavSafe` | ナビゲーションが進むのは**サーバが現モデルを保持している時のみ**（編集を持ったまま黙って離脱しない）|
| `NoFalseClean` | クライアントは**過少報告しない**（サーバが古いのに「保存済み」と誤らない）＝ **編集の消失なし** |

`NoFalseClean` が成立する＝ isDirty は安全側にしか外さない。ナビゲーションガード
（`NavClean` は `~IsDirty` の時だけ素通り）とあわせ、**データ損失は起きない**。

### 成立した活性（`AutosaveLive.cfg` → No error）

`ServerCatchesUp`（`<>[](serverLatest = modelVer)`）: 保存失敗が無ければ、編集は
いずれサーバへ届く（`WF(TimerFire)` ＋ `WF(SaveOk)`）。

### 発見された綻び（`BaselineConsistent` が違反）

「静止状態（タイマ off・in-flight 空・ダイアログ/ナビ無し）ではクライアントの
baseline がモデルに一致する」が**2通りの経路で破れる**:

**① 失敗した自動保存はリトライされない**（`AutosaveRace.cfg`, 完全 Spec）
```
Edit(modelVer=1) → TimerFire(save1) → SaveFail(1)
  ⇒ timer=off, inflight={}, lastSaved=0, modelVer=1  = dirty のまま静止
```
`saveNote` 失敗時にデバウンス効果は再アームしない（モデル変化でしか再アームしない）ため、
一時的なネットワーク失敗後、次の編集かナビゲーションまで**自動再送されない**。

**② 並行保存のレスポンス順序逆転で baseline が後退**（`AutosaveRaceHappy.cfg`, 失敗除外）
```
Edit(1) → TimerFire(save1) → Edit(2) → TimerFire(save2)   inflight={1,2}
SaveOk(2): lastSaved=2 → SaveOk(1): lastSaved=1（後退！）
  ⇒ modelVer=2, lastSaved=1  = dirty のまま。ただし serverLatest=2
```
古い save1 が後に完了し `lastSavedContentRef` を 1 へ巻き戻す。版ガードが無いため
isDirty が偽陽性になり、一時的に「未保存」表示や**冗長な再保存**が起きる。
`serverLatest=2` の通り**サーバは最新（データ損失なし）**。

## 影響と対策

いずれも **safety は保たれる**（`NoFalseClean`/`NavSafe` 成立＝離脱時の消失なし、
`serverLatest` は最新）。綻びは **UI の一時的な偽「未保存」・冗長な再保存・失敗時の
無自動リトライ** という UX 上のもの。対策候補:
- `lastSavedContentRef` を**版ガード付き更新**（`if (savedVer > lastSavedVer)` のように
  巻き戻さない）、または保存にシーケンス番号/リクエストIDを付与。
- 保存失敗時に**指数バックオフで再アーム**（現状は次編集/ナビ頼み）。

## 前提と限界

- TLC は有界探索（`MaxVer=2`、並行保存 ≤2）。`serverLatest` は**リクエスト送出順で
  サーバが適用する楽観モデル**（単一オリジン・順序保持）。HTTP/2 多重化や複数コネクション
  でサーバ側の適用順まで逆転する場合は別途 serverLatest の逆転（真のデータ損失）も起こり
  うるが、本モデルはクライアント可観測な綻びに集中している。
- `-deadlock` は、編集上限到達やナビ確定などの意図した terminal を誤検出しないためのフラグ。

## 実行

```bash
cd formal/round8/tla && ./run.sh
# safety / liveness → No error、race 2種 → BaselineConsistent violated
```
