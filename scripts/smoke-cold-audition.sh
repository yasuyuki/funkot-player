#!/bin/sh
# Cold-start audition smoke on device. Usage: smoke-cold-audition.sh <adb-addr>
set -eu
S="${1:?adb address}"
adb connect "$S" >/dev/null

dump() {
  adb -s "$S" shell uiautomator dump /sdcard/uidump.xml >/dev/null
  adb -s "$S" pull /sdcard/uidump.xml /tmp/uidump.xml >/dev/null
}

tap_pred() {
  pred="$1"
  python3 - "$pred" <<'PY'
import re, sys
pred = sys.argv[1]
xml = open("/tmp/uidump.xml", encoding="utf-8", errors="replace").read()
for m in re.finditer(r"<node [^>]+/>", xml):
    n = m.group(0)
    if pred == "flagged_row":
        ok = ("出る側" in n or "入る側" in n) and 'clickable="true"' in n
    elif pred == "listen":
        ok = "つなぎを聴く" in n and 'enabled="true"' in n and 'clickable="true"' in n
    elif pred == "resume_audition":
        ok = "〔再開〕" in n and 'clickable="true"' in n and 'enabled="true"' in n
    else:
        ok = False
    if not ok:
        continue
    b = re.search(r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', n)
    if not b:
        continue
    x = (int(b.group(1)) + int(b.group(3))) // 2
    y = (int(b.group(2)) + int(b.group(4))) // 2
    open("/tmp/tapxy", "w").write(f"{x} {y}")
    print("TAP", x, y, n[0:160].replace("\n", " "))
    sys.exit(0)
print("NO_MATCH", pred)
for t in re.findall(r'text="([^"]+)"', xml):
    if t.strip():
        print(" text:", t)
sys.exit(2)
PY
  set -- $(cat /tmp/tapxy)
  adb -s "$S" shell input tap "$1" "$2"
}

has_text() {
  grep -q "$1" /tmp/uidump.xml
}

show_texts() {
  python3 - <<'PY'
import re
xml=open("/tmp/uidump.xml",encoding="utf-8",errors="replace").read()
for t in re.findall(r'text="([^"]+)"', xml):
    if t.strip():
        print(t)
PY
}

echo "== open flagged =="
dump
tap_pred flagged_row
sleep 2
dump
show_texts

echo "== listen =="
tap_pred listen
# prepare + stretch can take tens of seconds on device
i=0
while [ "$i" -lt 40 ]; do
  sleep 3
  dump
  if has_text "〔再開〕"; then
    echo "audition banner ready after ${i}*3s"
    break
  fi
  echo "waiting audition... $i"
  i=$((i + 1))
done
show_texts

echo "== resume =="
tap_pred resume_audition
sleep 4
dump
echo "== after resume =="
show_texts
python3 - <<'PY'
import re
xml=open("/tmp/uidump.xml",encoding="utf-8",errors="replace").read()
texts=[t for t in re.findall(r'text="([^"]+)"', xml) if t.strip()]
top=" | ".join(texts[:12])
print("TOP:", top)
# Failure signature from HANDOFF: title blank / position --:-- after resume
if "〔再開〕" in top or "試聴中" in "".join(texts[:8]):
    print("VERDICT: still in audition UI")
elif texts[:4] == ["Funkot", "待機中", "--:--", "--:--"] or (
    len(texts) >= 4 and texts[1] in ("待機中",) and texts[2] == "--:--" and texts[3] == "--:--"
):
    # cold start: after resume main may briefly idle then TrackStarted fills title.
    # If still empty after 4s sleep, likely the bug.
    print("VERDICT: FAIL? now card still empty (待機中/--:--)")
elif any(t == "--:--" for t in texts[1:6]) and not any(
    len(t) > 2 and t not in ("Funkot", "開始", "一時停止", "再開", "次の曲", "⏭ 次の曲", "⏸ 一時停止", "▶ 再開", "待機中", "--:--")
    for t in texts[1:8]
):
    print("VERDICT: FAIL? no title near now card")
else:
    print("VERDICT: OK-ish (title or playing state present) — confirm by ear")
PY
