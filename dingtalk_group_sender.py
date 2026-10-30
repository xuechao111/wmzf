"""DingTalk webhook sender. Credentials stay in the ignored local config."""
import json
import sys
import urllib.request
from pathlib import Path
import os

CONFIG = Path(os.environ.get("HF_DASHBOARD_ROOT") or Path(__file__).resolve().parent / "instances" / "test") / "group-broadcast.local.json"


def send_text(text):
    return send_payload({"msgtype": "text", "text": {"content": text}})


def send_markdown(title, text, at_mobiles=None):
    payload = {"msgtype": "markdown", "markdown": {"title": title, "text": text}}
    if at_mobiles:
        payload["at"] = {"atMobiles": list(at_mobiles), "isAtAll": False}
    return send_payload(payload)


def send_payload(payload):
    config = json.loads(CONFIG.read_text(encoding="utf-8"))
    transport = config["transport"]
    if payload['msgtype'] == 'text':
        payload['text']['content'] = transport['keyword'] + '\n' + payload['text']['content']
    else:
        payload['markdown']['text'] = transport['keyword'] + '\n\n' + payload['markdown']['text']
    request = urllib.request.Request(transport["webhook"], data=json.dumps(payload, ensure_ascii=False).encode("utf-8"), headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=25) as response:
            result = json.load(response)
    except Exception:
        # Do not expose credential-bearing request URLs in error output.
        raise RuntimeError("机器人请求失败，请检查网络与本地连接配置") from None
    if result.get("errcode") != 0:
        raise RuntimeError(f"钉钉拒绝消息：{result.get('errcode')} {result.get('errmsg', '')}")
    return {"ok": True, "targetGroup": config["targetGroup"]}


if __name__ == "__main__":
    if sys.argv[1:] != ["--test"]:
        raise SystemExit("Use --test to send one connection test.")
    print(json.dumps(send_text("教学数据通晒连接测试。目标群已改为本群；图片定时通晒尚未启用。计划：每天14:00、18:00、20:00、21:00，周五周六直播后数据更新成功再加发。"), ensure_ascii=False))
