#!/usr/bin/env python3
import asyncio
import base64
import hashlib
import json
import logging
import os
import time
import uuid
import contextvars
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib import parse

import aiohttp
from fastapi import FastAPI, HTTPException, Request, BackgroundTasks
from fastapi.responses import HTMLResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

BASE_DIR = Path(__file__).parent
IS_VERCEL = bool(os.getenv("VERCEL"))
DISABLE_BACKGROUND_POLLING = bool(os.getenv("SMS_DISABLE_BACKGROUND_POLLING"))
DATA_DIR = Path(os.getenv("SMS_DATA_DIR", "/tmp/sms-sender" if IS_VERCEL else str(BASE_DIR)))
DATA_DIR.mkdir(parents=True, exist_ok=True)
SESSIONS_DIR = DATA_DIR / "sessions"
SESSIONS_DIR.mkdir(parents=True, exist_ok=True)

# Setup Logging
LOG_PATH = DATA_DIR / "audit.log"
WEB_SERVER_LOG_PATH = DATA_DIR / "web_server.log"
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.StreamHandler(),
        logging.FileHandler(WEB_SERVER_LOG_PATH, encoding="utf-8")
    ]
)
logger = logging.getLogger("sms_hub")

app = FastAPI(title="SMS Forwarding Hub")

@app.middleware("http")
async def session_middleware(request: Request, call_next):
    sid = request.headers.get("X-SMS-Session") or request.cookies.get(SESSION_COOKIE) or "shared"
    token = CURRENT_SESSION_ID.set(sid)
    try:
        response = await call_next(request)
        return response
    finally:
        CURRENT_SESSION_ID.reset(token)

# Paths
CONFIG_PATH = DATA_DIR / "web_config.json"
STATIC_DIR = BASE_DIR / "static"
SESSION_COOKIE = "sms_session"
SESSION_HEADER = "X-SMS-Session"
CURRENT_SESSION_ID: contextvars.ContextVar[str] = contextvars.ContextVar("CURRENT_SESSION_ID", default="shared")

# Global Client Session
HTTP_SESSION: aiohttp.ClientSession | None = None
POLLING_TASK: asyncio.Task | None = None

# Default Configuration
DEFAULT_CONFIG = {
    "license_key": os.getenv("SMS_LICENSE_KEY", ""),
    "firebase_url": os.getenv("SMS_FIREBASE_URL", ""),
    "auth_key": os.getenv("SMS_FIREBASE_AUTH_KEY", ""),
    "selected_device_id": os.getenv("SMS_DEVICE_ID", ""),
    "selected_sim_slot": int(os.getenv("SMS_SIM_SLOT", "1")),
    "poll_interval": int(os.getenv("SMS_POLL_INTERVAL", "2")),
    "incoming_poll_interval": float(os.getenv("SMS_INCOMING_POLL_INTERVAL", "0.5")),
    "last_timestamp": 0,
    "last_incoming_id": 0,
    "auto_inject_incoming": True,
    "is_polling_active": bool(os.getenv("SMS_LICENSE_KEY"))
}

def load_config() -> dict[str, Any]:
    return load_config_for_session(get_session_id())

def _session_key(session_id: str) -> str:
    return hashlib.sha256(session_id.encode("utf-8")).hexdigest()[:16]

def get_session_id(request: Request | None = None) -> str:
    if request is not None:
        sid = request.headers.get(SESSION_HEADER) or request.cookies.get(SESSION_COOKIE)
        if sid:
            return sid
    # fallback shared session for unauthenticated/default access
    return "shared"

def get_session_config_path(session_id: str) -> Path:
    if session_id == "shared":
        return CONFIG_PATH
    return SESSIONS_DIR / f"{_session_key(session_id)}.json"

def load_config_for_session(session_id: str) -> dict[str, Any]:
    config_path = get_session_config_path(session_id)
    if not config_path.exists():
        config = DEFAULT_CONFIG.copy()
        save_config_for_session(session_id, config)
        return config
    try:
        data = json.loads(config_path.read_text(encoding="utf-8"))
        # Ensure all default keys exist
        for k, v in DEFAULT_CONFIG.items():
            data.setdefault(k, v)
        return data
    except Exception as e:
        logger.error(f"Error loading config: {e}")
        return DEFAULT_CONFIG.copy()

def save_config(config: dict[str, Any]) -> None:
    save_config_for_session(get_session_id(), config)

def save_config_for_session(session_id: str, config: dict[str, Any]) -> None:
    try:
        config_path = get_session_config_path(session_id)
        config_path.parent.mkdir(parents=True, exist_ok=True)
        config_path.write_text(json.dumps(config, indent=2, ensure_ascii=False), encoding="utf-8")
    except Exception as e:
        logger.error(f"Error saving config: {e}")

def append_audit_log(entry: dict[str, Any]) -> None:
    try:
        session_id = str(entry.get("sessionId") or "shared")
        log_path = SESSIONS_DIR / _session_key(session_id) / "audit.log"
        log_path.parent.mkdir(parents=True, exist_ok=True)
        with log_path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except Exception as e:
        logger.error(f"Error writing to audit log: {e}")

# Firebase helper functions
def looks_online(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value == 1
    return str(value).strip().lower() in {"online", "true", "1", "yes", "connected"}

def looks_test(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value == 1
    return str(value).strip().lower() in {"test", "testing", "true", "1", "yes"}

def normalize_devices(raw: Any) -> list[str]:
    if not isinstance(raw, dict):
        return []
    found = set()
    for key, val in raw.items():
        if isinstance(val, dict):
            device_id = str(
                val.get("device_id")
                or val.get("deviceId")
                or val.get("id")
                or val.get("uid")
                or key
            ).strip()
            online = (
                looks_online(val.get("status"))
                or looks_online(val.get("state"))
                or bool(val.get("isOnline"))
                or bool(val.get("online"))
            )
            has_test_marker = any(
                k in val for k in ("type", "mode", "isTest", "test", "isTestDevice")
            )
            test_device = (
                looks_test(val.get("type"))
                or looks_test(val.get("mode"))
                or bool(val.get("isTest"))
                or bool(val.get("test"))
                or bool(val.get("isTestDevice"))
                or not has_test_marker
            )
            if device_id and online and test_device:
                found.add(device_id)
    return sorted(found)

async def firebase_get(url: str) -> Any:
    global HTTP_SESSION
    if not HTTP_SESSION:
        return None
    async with HTTP_SESSION.get(url) as resp:
        if resp.status == 200:
            body = await resp.text()
            return json.loads(body) if body else None
        return None

def build_firebase_path_url(base_url: str, auth_key: str, path: str) -> str:
    clean_base = base_url.rstrip("/")
    clean_path = path.strip("/")
    query = parse.urlencode({"auth": auth_key})
    return f"{clean_base}/{clean_path}.json?{query}"

async def fetch_online_devices(firebase_url: str, auth_key: str) -> list[str]:
    if not firebase_url or not auth_key:
        return []
    clean_base = firebase_url.rstrip("/")
    query = parse.urlencode({"auth": auth_key})
    
    candidate_paths = ["devices", "device_registry", "clients", "device_status"]
    devices = set()
    for path in candidate_paths:
        url = f"{clean_base}/{path}.json?{query}"
        try:
            data = await firebase_get(url)
            if data:
                devices.update(normalize_devices(data))
        except Exception as e:
            logger.warning(f"Error fetching path {path}: {e}")
            continue
    return sorted(devices)

def _coerce_message_id(key: Any, item: dict[str, Any]) -> int | None:
    raw_id = item.get("id", key)
    if isinstance(raw_id, (int, float)):
        return int(raw_id)
    try:
        return int(str(raw_id))
    except Exception:
        try:
            return int(str(key))
        except Exception:
            return None

def _coerce_timestamp_ms(value: Any) -> int:
    if isinstance(value, (int, float)):
        ts = int(value)
        return ts if ts > 10_000_000_000 else ts * 1000
    text = str(value or "").strip()
    if not text:
        return 0
    try:
        ts = int(float(text))
        return ts if ts > 10_000_000_000 else ts * 1000
    except Exception:
        pass
    for fmt in ("%Y-%m-%d %H:%M:%S", "%d/%m/%Y %H:%M:%S", "%d-%m-%Y %H:%M:%S"):
        try:
            dt = datetime.strptime(text, fmt)
            return int(dt.replace(tzinfo=timezone.utc).timestamp() * 1000)
        except Exception:
            continue
    return 0

async def fetch_incoming_sms(config: dict[str, Any], limit: int = 20) -> list[dict[str, Any]]:
    firebase_url = config.get("firebase_url", "")
    auth_key = config.get("auth_key", "")
    device_id = config.get("selected_device_id", "")
    if not firebase_url or not auth_key or not device_id:
        return []

    data = await firebase_get(
        build_firebase_path_url(firebase_url, auth_key, f"messages/{parse.quote(device_id, safe='')}")
    )
    if not isinstance(data, dict):
        return []

    rows: list[tuple[int, int, dict[str, Any]]] = []
    for key, item in data.items():
        if not isinstance(item, dict):
            continue
        if str(item.get("type", "")).strip().lower() not in {"incoming", ""}:
            continue
        msg_id = _coerce_message_id(key, item)
        if msg_id is None:
            continue
        timestamp_ms = _coerce_timestamp_ms(
            item.get("timestamp") or item.get("time") or item.get("createdAt") or item.get("dateTime")
        )
        rows.append((timestamp_ms, msg_id, item))

    rows.sort(key=lambda row: (row[0], row[1]), reverse=True)
    incoming: list[dict[str, Any]] = []
    for timestamp_ms, msg_id, item in rows[: max(1, min(limit, 100))]:
        incoming.append(
            {
                "id": msg_id,
                "timestamp": timestamp_ms,
                "dateTime": str(item.get("dateTime") or item.get("createdAt") or item.get("time") or "-").strip(),
                "from": str(item.get("sender") or item.get("from") or item.get("phone") or "-").strip(),
                "message": str(item.get("message") or item.get("text") or item.get("body") or "").strip(),
                "simSlot": item.get("simSlot") or item.get("slot") or item.get("sim") or "-",
                "deviceId": device_id,
                "direction": "incoming",
                "status": "received",
            }
        )
    return incoming

async def check_device_online_status(firebase_url: str, auth_key: str, device_id: str) -> bool:
    if not firebase_url or not auth_key or not device_id:
        return False
    online_ids = await fetch_online_devices(firebase_url, auth_key)
    return device_id in online_ids

def build_send_sms_url(base_url: str, device_id: str, auth_key: str) -> str:
    clean_base = base_url.rstrip("/")
    query = parse.urlencode({"auth": auth_key})
    return f"{clean_base}/clients/{parse.quote(device_id)}/webhookEvent/sendSms.json?{query}"

async def firebase_put_json(url: str, payload: dict[str, Any]) -> dict[str, Any]:
    global HTTP_SESSION
    if not HTTP_SESSION:
        raise Exception("HTTP Session is not active")
    async with HTTP_SESSION.put(url, json=payload) as resp:
        resp.raise_for_status()
        body = await resp.text()
        return json.loads(body) if body else {}

async def send_sms_via_profex(config: dict[str, Any], to_number: str, message_text: str) -> dict[str, Any]:
    t0 = time.perf_counter()
    payload = {
        "from": int(config["selected_sim_slot"]),
        "to": to_number.strip(),
        "message": message_text.strip(),
        "isSended": False,
        "createdAt": datetime.now(timezone.utc).isoformat(),
    }
    send_sms_url = build_send_sms_url(
        config["firebase_url"], config["selected_device_id"], config["auth_key"]
    )
    result = await firebase_put_json(send_sms_url, payload)
    elapsed_s = time.perf_counter() - t0
    
    append_audit_log(
        {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "status": "queued",
            "direction": "outgoing",
            "deviceId": config["selected_device_id"],
            "simSlot": config["selected_sim_slot"],
            "to": to_number,
            "message": message_text,
            "elapsedSeconds": round(elapsed_s, 4),
            "result": result,
        }
    )
    return result

async def inject_sms_to_vercel_api(license_key: str, sender: str, body: str) -> dict[str, Any]:
    if HTTP_SESSION is None:
        raise RuntimeError("HTTP session is not active")

    payload = {
        "licenseKey": license_key.strip(),
        "sender": sender.strip(),
        "body": body.strip(),
    }
    async with HTTP_SESSION.post(
        "https://vercelsmsapi.vercel.app/api/inject",
        json=payload,
        timeout=8,
    ) as resp:
        text = await resp.text()
        try:
            result = json.loads(text) if text else {}
        except Exception:
            result = {"raw": text}
        if resp.status >= 400 or not result.get("success", False):
            raise RuntimeError(result.get("error") or f"VercelSMSAPI returned {resp.status}")
        return result

async def process_incoming_injections_once() -> dict[str, Any]:
    config = load_config()
    if not config.get("auto_inject_incoming", True) or not config.get("license_key"):
        return {"success": True, "active": False, "processed": 0}
    if not config.get("firebase_url") or not config.get("auth_key") or not config.get("selected_device_id"):
        return {"success": True, "active": True, "processed": 0, "configured": False}

    messages = await fetch_incoming_sms(config, limit=50)
    if not messages:
        return {"success": True, "active": True, "processed": 0}

    last_incoming_id = int(config.get("last_incoming_id") or 0)
    newest_id = max((int(msg.get("id") or 0) for msg in messages), default=0)

    if last_incoming_id == 0:
        config["last_incoming_id"] = newest_id
        save_config(config)
        logger.info(f"Initialized incoming SMS cursor to id {newest_id} without injecting historical messages.")
        return {"success": True, "active": True, "processed": 0, "initialized": True}

    pending = [
        msg for msg in messages
        if int(msg.get("id") or 0) > last_incoming_id and msg.get("from") and msg.get("message")
    ]
    pending.sort(key=lambda msg: int(msg.get("id") or 0))

    processed = 0
    for msg in pending:
        t0 = time.perf_counter()
        try:
            result = await inject_sms_to_vercel_api(
                config["license_key"],
                str(msg["from"]),
                str(msg["message"]),
            )
            elapsed_s = time.perf_counter() - t0
            processed += 1
            append_audit_log({
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "status": "auto_injected",
                "direction": "incoming",
                "from": msg["from"],
                "message": msg["message"],
                "deviceId": config["selected_device_id"],
                "elapsedSeconds": round(elapsed_s, 4),
                "result": result,
            })
            logger.info(f"Auto-injected incoming SMS from {msg['from']} in {elapsed_s:.3f}s")
        except Exception as e:
            elapsed_s = time.perf_counter() - t0
            logger.error(f"Incoming SMS injection failed: {e}")
            append_audit_log({
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "status": "auto_inject_failed",
                "direction": "incoming",
                "from": msg.get("from"),
                "message": msg.get("message"),
                "deviceId": config["selected_device_id"],
                "elapsedSeconds": round(elapsed_s, 4),
                "error": str(e),
            })

        msg_id = int(msg.get("id") or 0)
        if msg_id > config.get("last_incoming_id", 0):
            config["last_incoming_id"] = msg_id
            save_config(config)

    if newest_id > config.get("last_incoming_id", 0):
        config["last_incoming_id"] = newest_id
        save_config(config)
    return {"success": True, "active": True, "processed": processed}

# Vercel Polling Task
LAST_POLL_TIME: str = "Never"

async def poll_vercel_sms_once() -> dict[str, Any]:
    global LAST_POLL_TIME
    config = load_config()
    if not config["is_polling_active"] or not config["license_key"]:
        return {"success": True, "active": False, "processed": 0}

    if HTTP_SESSION is None:
        raise RuntimeError("HTTP session is not active")

    processed = 0
    license_key = config["license_key"]
    last_timestamp = config["last_timestamp"]

    url = f"https://vercelsmsviewer.vercel.app/api/get-sms?key={parse.quote(license_key)}"
    if last_timestamp:
        url += f"&since={last_timestamp}"

    LAST_POLL_TIME = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    async with HTTP_SESSION.get(url, timeout=10) as resp:
        if resp.status != 200:
            logger.warning(f"Vercel API returned status code {resp.status}")
            return {"success": False, "active": True, "processed": 0, "status_code": resp.status}

        data = await resp.json()
        if not data.get("success") or "records" not in data:
            return {"success": False, "active": True, "processed": 0, "error": data.get("error", "Invalid API response")}

        records = data["records"]
        if not records:
            return {"success": True, "active": True, "processed": 0}

        records_to_process = sorted(records, key=lambda r: r.get("timestamp", 0))

        # On the first poll, advance the cursor without forwarding old messages.
        if last_timestamp == 0:
            max_ts = max(r.get("timestamp", 0) for r in records_to_process)
            config["last_timestamp"] = max_ts
            save_config(config)
            logger.info(f"Initialized Vercel cursor to timestamp {max_ts} without sending {len(records_to_process)} historical messages.")
            return {"success": True, "active": True, "processed": 0, "initialized": True}

        logger.info(f"Fetched {len(records_to_process)} new records from Vercel")
        for rec in records_to_process:
            recipient = rec.get("recipient")
            body = rec.get("body")
            ts = rec.get("timestamp", 0)

            if recipient and body:
                logger.info(f"Forwarding SMS from Vercel: To={recipient}, Text={body}")
                try:
                    if config["firebase_url"] and config["selected_device_id"]:
                        await send_sms_via_profex(config, recipient, body)
                        processed += 1
                        logger.info(f"Successfully forwarded SMS to Profex: To={recipient}")
                    else:
                        logger.warning("SMS fetched but Firebase URL or active device not configured.")
                        append_audit_log({
                            "timestamp": datetime.now(timezone.utc).isoformat(),
                            "status": "config_missing",
                            "direction": "outgoing",
                            "to": recipient,
                            "message": body,
                            "error": "Firebase URL or Device ID not set"
                        })
                except Exception as ex:
                    logger.error(f"Error forwarding SMS: {ex}")
                    append_audit_log({
                        "timestamp": datetime.now(timezone.utc).isoformat(),
                        "status": "send_failed",
                        "direction": "outgoing",
                        "to": recipient,
                        "message": body,
                        "error": str(ex)
                    })

            if ts > config["last_timestamp"]:
                config["last_timestamp"] = ts
                save_config(config)

    return {"success": True, "active": True, "processed": processed}

async def vercel_polling_loop():
    logger.info("Vercel SMS Polling loop started")
    while True:
        try:
            await poll_vercel_sms_once()
            await process_incoming_injections_once()
        except asyncio.CancelledError:
            break
        except Exception as e:
            logger.error(f"Error in Vercel polling loop: {e}")
            
        # Wait for the configured poll interval (default 2s)
        config = load_config()
        try:
            interval = float(config.get("incoming_poll_interval", 0.5))
        except Exception:
            interval = 0.5
        interval = max(0.25, min(interval, 1.0))
        await asyncio.sleep(interval)

# FastAPI Events
@app.on_event("startup")
async def startup_event():
    global HTTP_SESSION, POLLING_TASK
    HTTP_SESSION = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=10, connect=3))
    if DISABLE_BACKGROUND_POLLING:
        logger.info("Background polling disabled by SMS_DISABLE_BACKGROUND_POLLING.")
    elif not IS_VERCEL:
        POLLING_TASK = asyncio.create_task(vercel_polling_loop())
    else:
        logger.info("Vercel runtime detected; background polling is disabled. Use /api/poll-now or the configured cron route.")
    logger.info("Application startup complete.")

@app.on_event("shutdown")
async def shutdown_event():
    global HTTP_SESSION, POLLING_TASK
    if POLLING_TASK:
        POLLING_TASK.cancel()
        try:
            await POLLING_TASK
        except asyncio.CancelledError:
            pass
    if HTTP_SESSION:
        await HTTP_SESSION.close()
    logger.info("Application shutdown complete.")

def parse_profex_link(link: str) -> tuple[str, str] | None:
    try:
        # Extract query parameter 's'
        parsed_url = parse.urlparse(link.strip())
        query_params = parse.parse_qs(parsed_url.query)
        s_val = query_params.get("s", [None])[0]
        if not s_val:
            # Maybe they passed the raw base64 string directly
            s_val = link.strip()
            
        # Base64 decode
        # Handle padding issues
        missing_padding = len(s_val) % 4
        if missing_padding:
            s_val += '=' * (4 - missing_padding)
            
        decoded = base64.b64decode(s_val).decode("utf-8")
        if "|||" in decoded:
            parts = decoded.split("|||")
            if len(parts) == 2:
                return parts[0].strip(), parts[1].strip()
    except Exception as e:
        logger.error(f"Error parsing profex link: {e}")
    return None

class LoginRequest(BaseModel):
    license_key: str
    profex_link: str

class ImportLinkRequest(BaseModel):
    link: str

class ConfigUpdateRequest(BaseModel):
    firebase_url: str
    auth_key: str
    selected_device_id: str
    selected_sim_slot: int
    poll_interval: int
    incoming_poll_interval: float | None = None

class ManualSendRequest(BaseModel):
    to: str
    message: str

class InjectSmsRequest(BaseModel):
    sender: str
    body: str

# API Endpoints
@app.post("/api/login")
async def api_login(req: LoginRequest, response: Response):
    key = req.license_key.strip()
    link = req.profex_link.strip()
    if not key:
        raise HTTPException(status_code=400, detail="License key cannot be empty")
    if not link:
        raise HTTPException(status_code=400, detail="Profex Netlify link cannot be empty")
        
    # Decode the Profex Link first
    parsed = parse_profex_link(link)
    if not parsed:
        raise HTTPException(status_code=400, detail="Invalid Profex Link. Could not extract credentials.")
        
    firebase_url, auth_key = parsed
        
    # Verify the key against the Vercel API
    test_url = f"https://vercelsmsviewer.vercel.app/api/get-sms?key={parse.quote(key)}"
    try:
        async with HTTP_SESSION.get(test_url, timeout=8) as resp:
            if resp.status == 200:
                data = await resp.json()
                if data.get("success") == True:
                    # Key is valid! Save it, config, and activate polling
                    config = load_config()
                    old_license_key = config.get("license_key", "")
                    session_id = request_session_id = get_session_id()
                    if request_session_id == "shared":
                        request_session_id = uuid.uuid4().hex
                    response.set_cookie(SESSION_COOKIE, request_session_id, httponly=True, samesite="lax")
                    response.headers[SESSION_HEADER] = request_session_id
                    session_id = request_session_id
                    config["license_key"] = key
                    config["firebase_url"] = firebase_url
                    config["auth_key"] = auth_key
                    config["is_polling_active"] = True
                    # If this is a new key, reset the cursor
                    if old_license_key != key:
                        config["last_timestamp"] = 0
                    save_config_for_session(session_id, config)
                    return {"success": True, "message": "Access granted"}
                else:
                    raise HTTPException(status_code=401, detail=data.get("error", "Invalid license key"))
            else:
                raise HTTPException(status_code=502, detail="Vercel API validation failed")
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Login validation error: {e}")
        raise HTTPException(status_code=500, detail=f"Validation error: {str(e)}")

@app.post("/api/logout")
async def api_logout(response: Response):
    config = load_config()
    config["is_polling_active"] = False
    config["license_key"] = ""
    config["last_timestamp"] = 0
    save_config(config)
    response.delete_cookie(SESSION_COOKIE)
    response.headers[SESSION_HEADER] = ""
    return {"success": True}

@app.post("/api/config/import-link")
async def api_import_link(req: ImportLinkRequest):
    parsed = parse_profex_link(req.link)
    if not parsed:
        raise HTTPException(status_code=400, detail="Invalid Profex Link. Could not extract credentials.")
    
    firebase_url, auth_key = parsed
    config = load_config()
    config["firebase_url"] = firebase_url
    config["auth_key"] = auth_key
    save_config(config)
    return {
        "success": True, 
        "firebase_url": firebase_url, 
        "auth_key": auth_key
    }

@app.get("/api/config")
async def api_get_config():
    config = load_config()
    # Return configuration details (hide license key slightly for safety, or return since it is local)
    return {
        "firebase_url": config["firebase_url"],
        "auth_key": config["auth_key"],
        "selected_device_id": config["selected_device_id"],
        "selected_sim_slot": config["selected_sim_slot"],
        "poll_interval": config["poll_interval"],
        "incoming_poll_interval": config.get("incoming_poll_interval", 0.5),
    }

@app.post("/api/config")
async def api_update_config(req: ConfigUpdateRequest):
    config = load_config()
    config["firebase_url"] = req.firebase_url.strip()
    config["auth_key"] = req.auth_key.strip()
    config["selected_device_id"] = req.selected_device_id.strip()
    config["selected_sim_slot"] = req.selected_sim_slot
    config["poll_interval"] = max(1, req.poll_interval)
    if req.incoming_poll_interval is not None:
        config["incoming_poll_interval"] = max(0.25, min(float(req.incoming_poll_interval), 1.0))
    save_config(config)
    return {"success": True}

@app.get("/api/status")
async def api_get_status():
    config = load_config()
    license_key = config["license_key"]
    
    online_devices = []
    device_online = False
    firebase_ok = False
    
    if config["firebase_url"] and config["auth_key"]:
        try:
            online_devices = await fetch_online_devices(config["firebase_url"], config["auth_key"])
            firebase_ok = True
            if config["selected_device_id"]:
                device_online = config["selected_device_id"] in online_devices
        except Exception as e:
            logger.error(f"Status check Firebase error: {e}")
            
    return {
        "authenticated": bool(license_key),
        "firebase_configured": bool(config["firebase_url"]),
        "firebase_connected": firebase_ok,
        "online_devices": online_devices,
        "selected_device_online": device_online,
        "vercel_polling": config["is_polling_active"],
        "last_poll_time": LAST_POLL_TIME,
        "last_timestamp": config["last_timestamp"]
    }

@app.post("/api/send-test")
async def api_send_test(req: ManualSendRequest):
    config = load_config()
    if not config["firebase_url"] or not config["auth_key"] or not config["selected_device_id"]:
        raise HTTPException(status_code=400, detail="Firebase URL, Auth Key, or Selected Device is missing")
        
    try:
        result = await send_sms_via_profex(config, req.to, req.message)
        return {"success": True, "result": result}
    except Exception as e:
        logger.error(f"Manual send error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/inject-sms")
async def api_inject_sms(req: InjectSmsRequest):
    config = load_config()
    license_key = config.get("license_key", "").strip()
    sender = req.sender.strip()
    body = req.body.strip()

    if not license_key:
        raise HTTPException(status_code=401, detail="Login/license key missing. Please login first.")
    if not sender or not body:
        raise HTTPException(status_code=400, detail="Sender and message body are required")
    if HTTP_SESSION is None:
        raise HTTPException(status_code=503, detail="HTTP session is not active")

    payload = {
        "licenseKey": license_key,
        "sender": sender,
        "body": body,
    }
    t0 = time.perf_counter()
    try:
        async with HTTP_SESSION.post(
            "https://vercelsmsapi.vercel.app/api/inject",
            json=payload,
            timeout=8,
        ) as resp:
            text = await resp.text()
            try:
                result = json.loads(text) if text else {}
            except Exception:
                result = {"raw": text}

            elapsed_s = time.perf_counter() - t0
            if resp.status >= 400 or not result.get("success", False):
                append_audit_log({
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                    "status": "inject_failed",
                    "direction": "incoming",
                    "from": sender,
                    "message": body,
                    "elapsedSeconds": round(elapsed_s, 4),
                    "result": result,
                    "statusCode": resp.status,
                })
                raise HTTPException(
                    status_code=502,
                    detail=result.get("error") or f"VercelSMSAPI returned {resp.status}",
                )

            append_audit_log({
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "status": "injected",
                "direction": "incoming",
                "from": sender,
                "message": body,
                "elapsedSeconds": round(elapsed_s, 4),
                "result": result,
            })
            return {"success": True, "result": result, "elapsedSeconds": round(elapsed_s, 4)}
    except HTTPException:
        raise
    except Exception as e:
        elapsed_s = time.perf_counter() - t0
        append_audit_log({
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "status": "inject_failed",
            "direction": "incoming",
            "from": sender,
            "message": body,
            "elapsedSeconds": round(elapsed_s, 4),
            "error": str(e),
        })
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/poll-now")
async def api_poll_now():
    try:
        return await poll_vercel_sms_once()
    except Exception as e:
        logger.error(f"Poll-now error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/cron")
async def api_cron():
    try:
        return await poll_vercel_sms_once()
    except Exception as e:
        logger.error(f"Cron polling error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/logs")
async def api_get_logs(limit: int = 50):
    if not LOG_PATH.exists():
        return []
    try:
        lines = LOG_PATH.read_text(encoding="utf-8").strip().split("\n")
        parsed_logs = []
        for line in reversed(lines):
            if not line:
                continue
            try:
                parsed_logs.append(json.loads(line))
            except Exception:
                parsed_logs.append({"timestamp": datetime.now(timezone.utc).isoformat(), "message": line, "status": "raw"})
            if len(parsed_logs) >= limit:
                break
        return parsed_logs
    except Exception as e:
        logger.error(f"Error reading logs: {e}")
        return []

@app.get("/api/incoming-sms")
async def api_get_incoming_sms(limit: int = 20):
    config = load_config()
    if not config["firebase_url"] or not config["auth_key"] or not config["selected_device_id"]:
        return {
            "success": True,
            "configured": False,
            "deviceId": config.get("selected_device_id", ""),
            "messages": [],
        }
    try:
        messages = await fetch_incoming_sms(config, limit=limit)
        newest_id = max((msg["id"] for msg in messages), default=0)
        if newest_id > config.get("last_incoming_id", 0):
            config["last_incoming_id"] = newest_id
            save_config(config)
        return {
            "success": True,
            "configured": True,
            "deviceId": config["selected_device_id"],
            "messages": messages,
        }
    except Exception as e:
        logger.error(f"Incoming SMS fetch error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

# Direct Webhook Endpoint
@app.post("/webhook")
async def api_webhook(request: Request):
    config = load_config()
    # Expect text or JSON
    content_type = request.headers.get("content-type", "")
    to_number = None
    message_text = None
    
    if "application/json" in content_type:
        try:
            data = await request.json()
            to_number = data.get("to") or data.get("phone") or data.get("recipient")
            message_text = data.get("message") or data.get("text") or data.get("body")
            
            # If a single content block is sent, try parsing it as template
            if not to_number and (data.get("content") or data.get("raw")):
                raw = data.get("content") or data.get("raw")
                # Try template parse
                from main import parse_template_block
                try:
                    parsed = parse_template_block(raw)
                    to_number = parsed.to
                    message_text = parsed.message
                except Exception:
                    pass
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Invalid JSON: {e}")
    else:
        # Read raw text
        try:
            raw_text = (await request.body()).decode("utf-8")
            from main import parse_template_block
            parsed = parse_template_block(raw_text)
            to_number = parsed.to
            message_text = parsed.message
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Could not parse template block from text body: {e}")
            
    if not to_number or not message_text:
        raise HTTPException(status_code=400, detail="Missing 'to' or 'message' parameters or unparseable payload")
        
    if not config["firebase_url"] or not config["selected_device_id"]:
        raise HTTPException(status_code=503, detail="SMS gateway not configured in web settings")
        
    try:
        result = await send_sms_via_profex(config, to_number, message_text)
        return {"success": True, "result": result}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# Fallback to serve static files
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

@app.get("/", response_class=HTMLResponse)
async def serve_index():
    index_path = STATIC_DIR / "index.html"
    if index_path.exists():
        return index_path.read_text(encoding="utf-8")
    return """<html><body><h1>SMS Forwarding Hub</h1><p>Static index.html is missing inside /static folder.</p></body></html>"""

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", "5000")))
