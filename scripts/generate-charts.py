#!/usr/bin/env python3
"""譜面生成器の入口（単位Dで一本化したブートストラップ）。

生成器本体はテンプレート repo（mmishina-art/digitalcd-engine）の
scripts/chartgen/ パッケージが正で、この repo には複製を持たない。
この入口は、テンプレート clone の chartgen を参照し、この repo の
scripts/songs_config.py の SONGS と src/game/data/lyrics.json を入力に
src/game/data/charts.json を生成する。

前提: テンプレート clone が ~/workspace/digitalcd-engine/gh-clone にあること
（場所が違う場合は環境変数 DIGITALCD_TEMPLATE_SCRIPTS にテンプレートの
scripts ディレクトリを指定）。librosa の入った venv で実行する。
使い方: .venv/bin/python scripts/generate-charts.py [--jobs N] [--no-cache]
        [--songs id1,id2] [--lyrics <path>]
"""
import os
import sys
from pathlib import Path

sys.dont_write_bytecode = True  # __pycache__ を作らない
ROOT = Path(__file__).resolve().parent.parent


def _template_scripts() -> Path:
    env = os.environ.get("DIGITALCD_TEMPLATE_SCRIPTS")
    candidates = [env] if env else []
    candidates.append(str(Path.home() / "workspace" / "digitalcd-engine" / "gh-clone" / "scripts"))
    for c in candidates:
        if c and (Path(c) / "chartgen" / "cli.py").exists():
            return Path(c)
    raise SystemExit(
        "テンプレートの chartgen が見つかりません。テンプレート clone の scripts を "
        "環境変数 DIGITALCD_TEMPLATE_SCRIPTS に指定してください。"
    )


os.environ["CHARTGEN_ROOT"] = str(ROOT)
os.environ["CHARTGEN_SONGS_FILE"] = str(ROOT / "scripts" / "songs_config.py")
sys.path.insert(0, str(_template_scripts()))

from chartgen.cli import main

if __name__ == "__main__":
    sys.exit(main())
