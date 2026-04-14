from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path


PLUGIN_ROOT = Path(__file__).resolve().parents[1]
RUNTIME_ROOT = Path(os.environ.get("EAGLE_PLUGIN_RUNTIME_ROOT") or (PLUGIN_ROOT / ".runtime")).resolve()
DEPS_DIR = RUNTIME_ROOT / "python_deps"
os.environ.setdefault("PADDLE_HOME", str(RUNTIME_ROOT / "paddle_home"))
os.environ.setdefault("PADDLEX_HOME", str(RUNTIME_ROOT / "paddlex_home"))
os.environ.setdefault("XDG_CACHE_HOME", str(RUNTIME_ROOT / "cache"))
os.environ.setdefault("HF_HOME", str(RUNTIME_ROOT / "cache" / "huggingface"))
PADDLE_CPU_INDEX = "https://www.paddlepaddle.org.cn/packages/stable/cpu/"
PADDLEOCR_VERSION = "3.4.0"
PADDLEPADDLE_VERSION = "3.3.1"
REQUIRED_PATHS = [
    DEPS_DIR / "paddleocr" / "__init__.py",
    DEPS_DIR / "paddle" / "base" / "libpaddle.pyd",
]


def emit(payload: dict) -> None:
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def is_runtime_ready() -> bool:
    return all(path.exists() for path in REQUIRED_PATHS)


def run_command(args: list[str], title: str, message: str) -> None:
    emit({"type": "status", "title": title, "message": message})

    process = subprocess.Popen(
        args,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        encoding="utf-8",
        errors="replace",
        text=True,
    )

    assert process.stdout is not None
    for raw_line in process.stdout:
        line = raw_line.strip()
        if line:
            emit({"type": "log", "message": line})

    return_code = process.wait()
    if return_code != 0:
        raise RuntimeError(f"依赖安装命令执行失败，退出码 {return_code}")


def main() -> int:
    try:
        if is_runtime_ready():
            emit({
                "type": "done",
                "title": "本地 OCR 依赖已就绪",
                "message": "检测到本地 OCR 依赖已经安装完成。",
            })
            return 0

        DEPS_DIR.mkdir(parents=True, exist_ok=True)

        common_args = [
            sys.executable,
            "-m",
            "pip",
            "install",
            "--target",
            str(DEPS_DIR),
            "--upgrade",
            "--no-warn-script-location",
        ]

        try:
            run_command(
                [
                    *common_args,
                    "--extra-index-url",
                    PADDLE_CPU_INDEX,
                    f"paddlepaddle=={PADDLEPADDLE_VERSION}",
                    f"paddleocr=={PADDLEOCR_VERSION}",
                ],
                title="正在准备本地 OCR 组件",
                message="正在下载本地 OCR 组件，首次启动通常需要几分钟。",
            )
        except Exception:  # noqa: BLE001
            emit({
                "type": "log",
                "message": "一体化安装失败，正在切换为分步安装模式。",
            })
            run_command(
                [
                    *common_args,
                    "--index-url",
                    PADDLE_CPU_INDEX,
                    f"paddlepaddle=={PADDLEPADDLE_VERSION}",
                ],
                title="正在安装本地 OCR 引擎",
                message="正在准备本地 OCR 引擎。",
            )
            run_command(
                [
                    *common_args,
                    f"paddleocr=={PADDLEOCR_VERSION}",
                ],
                title="正在准备识别模型",
                message="正在准备识别模型和相关组件。",
            )

        if not is_runtime_ready():
            raise RuntimeError("依赖安装已完成，但本地 OCR 运行文件仍不完整。")

        emit({
            "type": "done",
            "title": "本地 OCR 依赖已就绪",
            "message": "依赖下载完成，后续识别可直接使用。",
        })
        return 0
    except Exception as error:  # noqa: BLE001
        emit({
            "type": "error",
            "title": "本地 OCR 依赖准备失败",
            "message": str(error),
        })
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
