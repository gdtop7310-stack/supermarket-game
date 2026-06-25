# 🛒 スーパー経営アイドル — Supermarket Tycoon

ローポリ3Dの「スーパー経営アイドル」ゲーム。店員を歩かせて
**農場で収穫 → 棚に補充 → お客さんが購入してお金に → アップグレードで拡張**、
という idle 経営型ゲームです。参考イメージは Idle Supermarket / Farm Tycoon 系。

## 遊び方

1. `index.html` を**ダブルクリックして開くだけ**（ローカルサーバ不要・オフライン動作）。
2. 「▶ スタート」を押す。
3. **移動**: `WASD` / 矢印キー、スマホは画面左下のバーチャルスティック。
4. 緑のビーム（チュートリアル目印）に従って：
   - 奥の**農場**（緑エリア, z>0）で作物を**収穫**（近づくと自動）。
   - 手前の**店**（白エリア, z<0）の**棚**に**補充**（近づくと自動）。
   - お客さんが買い物 → レジで会計 → **お金**が増える。
   - 光る**アップグレード台**に乗ると、貯金で棚のアンロック／手持ち上限／レジ増設。

進捗は `localStorage` に自動セーブされます（HUDの「セーブをリセット」で初期化）。

> **同梱ファイル `three.min.js` について**
> 本ゲームは Three.js r149（UMD/グローバル版）をローカル同梱する設計です。
> もしリポジトリに `three.min.js` が無い場合は、`index.html` と同じフォルダに配置してください：
> ```sh
> npm pack three@0.149.0           # three-0.149.0.tgz を取得
> tar -xzf three-0.149.0.tgz package/build/three.min.js
> mv package/build/three.min.js ./three.min.js
> ```

## 構成（ロジックと描画を分離）

| ファイル | 役割 |
|---|---|
| `index.html` | 骨組み・HUD・スタート画面・スマホUI。読込順 `three.min.js → game.js → render3d.js` |
| `style.css` | フルスクリーンcanvas・HUD・スマホスティック |
| `game.js` | ゲームロジック。`window.Game` を公開（描画と疎結合） |
| `render3d.js` | Three.js でローポリ3D描画。`Game.getState()` を毎フレーム同期 |
| `three.min.js` | Three.js r149（グローバル/UMD版）を同梱 |

### 技術方針

ES Modules + CDN importmap は `file://` で開くと CORS で動かないため、
**あえて Three.js をローカル同梱し通常の `<script>` で読み込む**方式です。
「ダウンロードして `index.html` を開くだけ・オフラインで動く」を維持しています。

### `window.Game` の契約（描画↔ロジックの境界）

```
WORLD = { minX:-20, maxX:20, minZ:-14, maxZ:14 }   // 店=z<0 / 農場=z>0 / 入口=x≈minX
start(), update(dt), setMove(mx,mz), getState(), onMoney(cb), onUnlock(cb)
```

`getState()` は `{ running, money, carryCap, player, sources, shelves,
checkouts, customers, pads, floats, tutorialTarget }` を返します。
