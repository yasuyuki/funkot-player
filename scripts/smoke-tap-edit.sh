#!/bin/sh
# Edit-mode entry smoke on device. Usage: smoke-tap-edit.sh <adb-addr>
# Dumps the node that carries 編集モードへ / 編集 and taps its centre.
set -eu
S="${1:?adb address}"
adb connect "$S" >/dev/null
adb -s "$S" shell monkey -p jp.hatsuboshi.funkotplayer -c android.intent.category.LAUNCHER 1 >/dev/null
sleep 2
adb -s "$S" shell uiautomator dump /sdcard/uidump.xml >/dev/null
adb -s "$S" pull /sdcard/uidump.xml /tmp/uidump.xml >/dev/null
python3 - <<'PY'
import re
xml = open("/tmp/uidump.xml", encoding="utf-8", errors="replace").read()
# Prefer content-desc 編集モードへ, else text 編集
patterns = [
    r'content-desc="編集モードへ"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"',
    r'text="編集"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"',
    r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"[^>]*content-desc="編集モードへ"',
    r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"[^>]*text="編集"',
]
# nodes may order attrs differently; scan each node chunk
for m in re.finditer(r"<node [^>]+/>", xml):
    n = m.group(0)
    if ("編集モードへ" in n) or ('text="編集"' in n):
        b = re.search(r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', n)
        print(n[:240])
        if b:
            x = (int(b.group(1)) + int(b.group(3))) // 2
            y = (int(b.group(2)) + int(b.group(4))) // 2
            open("/tmp/tapxy", "w").write(f"{x} {y}")
            print("TAP", x, y)
            break
else:
    # list nearby buttons for debug
    for m in re.finditer(r'text="([^"]+)"', xml):
        t = m.group(1)
        if t and any(k in t for k in ("編集", "再生", "開始", "不適切", "つなぎ")):
            print("seen", t)
PY
if [ -f /tmp/tapxy ]; then
  set -- $(cat /tmp/tapxy)
  adb -s "$S" shell input tap "$1" "$2"
  sleep 1.5
  adb -s "$S" shell uiautomator dump /sdcard/uidump.xml >/dev/null
  adb -s "$S" pull /sdcard/uidump.xml /tmp/uidump2.xml >/dev/null
  python3 - <<'PY'
import re
xml=open("/tmp/uidump2.xml",encoding="utf-8",errors="replace").read()
for t in re.findall(r'text="([^"]+)"', xml):
    if t.strip():
        print(t)
PY
fi
