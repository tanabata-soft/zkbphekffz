"""作品の曲設定（NK-S001）。

単位D（生成器一本化）: 生成器本体の正はテンプレート repo
（mmishina-art/digitalcd-engine）の scripts/chartgen/ パッケージ1か所。
作品側はこの SONGS メタデータと歌詞入力（src/game/data/lyrics.json）だけを
持ち、scripts/generate-charts.py（入口ブートストラップ）がテンプレートの
chartgen を参照して生成する。曲を足すときはここに1曲分を足す。
各キーの意味はテンプレート scripts/chartgen/config.py のコメント参照。
"""

SONGS = {
    # NK-S001『チョコミントの残像』の収録曲。音源は src/game/assets/track0N.mp3
    # （唯一の正規音源 MP3 192kbps。CD 側プレイヤーも同じ音源を共有する）。
    # FEVER（サビ）区間は、歌詞（src/album/sync.ts）の反復ブロックから決める:
    # サビの歌詞ブロックの先頭行の開始秒を開始、末尾行の歌唱が終わる頃を終了とする
    # （NK-S003 での決め方）。
    # サビは歌に合わせて主レイヤーを vocal にする（NK-S003 のオーナー指示）。
    "chocomint": {
        "title": "チョコミントの残像",
        "audio": "src/game/assets/track01.mp3",
        # サビは「響け、私の声！」のブロック（2回）:
        # 38.1〜57.6 の行の歌唱終わり / 90.6〜108.1 の行の歌唱終わり
        "fever": [[38.0, 63.0], [90.0, 114.0]],
        "chart_v5": True,
        "flick": True,
        "chorus_layer": "vocal",
        "chorus_bonus": 0.5,
        # v6-5: バラードプロファイルの明示メタ（実測分類に基づく。
        # アップテンポなロックで対象外のため OFF）
        "ballad": False,
    },
    "tokeruyoru": {
        "title": "Chocomintの溶ける夜",
        "audio": "src/game/assets/track02.mp3",
        # サビは「ずっとそばにいたいよ」の反復ブロック（2回）:
        # 61.0〜87.0 の行の歌唱終わり / 121.0〜146.0 の行の歌唱終わり
        "fever": [[61.0, 92.0], [121.0, 151.0]],
        "chart_v5": True,
        "flick": True,
        "chorus_layer": "vocal",
        "chorus_bonus": 0.5,
        "ballad": False,
        # v6-5: バラードプロファイルの明示メタ。生成レポートの自動判定は
        # detectScore 3 で OFF（BPM 134.47、barDynP90P50 1.70 が高め）。
        # v6-4 被覆も unfilledGaps 0・capExceeded なしで問題なかったため、
        # 公開済み作品の慣例どおり明示 False を記録する（有効化は変わらず OFF
        # なので譜面は生成済みのものと一致する）。
    },
}
