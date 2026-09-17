"""Official WeChat API transport. Tokens live only in this account's process."""

from __future__ import annotations

import json
import time
from pathlib import Path

import requests

API_BASE = "https://api.weixin.qq.com/cgi-bin/"
TOKEN_ERRORS = {40001, 40014, 42001}
ERROR_HINTS = {
    40007: "media_id is invalid or the draft was consumed",
    40125: "check the selected account's AppSecret environment variable",
    40164: "add the execution server's IP to this account's IP allowlist",
    45009: "daily API quota reached", 45011: "rate limit reached",
    45028: "publishing quota reached", 45065: "this clientmsgid already has a mass-send task",
    48001: "the selected account has not been granted this API permission",
    48021: "save the draft manually in the WeChat backend before sending",
    89503: "waiting for administrator approval in WeChat",
    89504: "mass sending is still waiting for administrator approval",
    89505: "mass sending entered the administrator confirmation workflow",
}


class ApiError(ValueError):
    def __init__(self, code, endpoint, result=None):
        self.code, self.endpoint, self.result = code, endpoint, result or {}
        super().__init__(f"WeChat {endpoint}: error {code}; {ERROR_HINTS.get(code, 'check the official API error code')}")


class TransportError(ValueError):
    def __init__(self, message, dispatched=True):
        self.dispatched = dispatched
        super().__init__(message)


class WeChatAPI:
    def __init__(self, app_id: str, secret: str, request=None, now=time.time):
        if not app_id or not secret:
            raise ValueError("selected account credentials are missing")
        self.app_id, self.secret = app_id, secret
        self.request, self.now = request or requests.post, now
        self.token, self.expires_at = "", 0

    def _post(self, endpoint, payload=None, token=None, image: Path | None = None, query=None):
        params = dict(query or {})
        if token:
            params["access_token"] = token
        options = {"params": params, "timeout": (10, 60), "allow_redirects": False}
        if image is not None:
            options["files"] = {"media": (image.name, image.read_bytes(), "image/jpeg" if image.suffix == ".jpg" else "image/png")}
        else:
            options["data"] = json.dumps(payload or {}, ensure_ascii=False).encode("utf-8")
            options["headers"] = {"Content-Type": "application/json; charset=utf-8"}
        try:
            response = self.request(API_BASE + endpoint, **options)
            if response.status_code != 200:
                raise TransportError(f"WeChat {endpoint}: HTTP {response.status_code}; outcome needs reconciliation")
            value = response.json()
        except (requests.RequestException, OSError, ValueError) as error:
            if isinstance(error, TransportError):
                raise
            # Exception URLs and server errmsg strings may contain credentials.
            raise TransportError(f"WeChat {endpoint}: transport or response error; outcome needs reconciliation") from None
        if not isinstance(value, dict):
            raise TransportError(f"WeChat {endpoint}: invalid response object")
        if value.get("errcode", 0) != 0:
            raise ApiError(value["errcode"], endpoint, value)
        return value

    def access_token(self):
        if self.token and self.now() < self.expires_at:
            return self.token
        try:
            result = self._post("stable_token", {"grant_type": "client_credential", "appid": self.app_id,
                                                 "secret": self.secret, "force_refresh": False})
        except TransportError as error:
            error.dispatched = False
            raise
        token, ttl = result.get("access_token"), result.get("expires_in")
        if not isinstance(token, str) or not token or not isinstance(ttl, (int, float)) or ttl <= 0:
            raise TransportError("WeChat stable_token: missing token or expiry", dispatched=False)
        self.token, self.expires_at = token, self.now() + max(0, ttl - 60)
        return token

    def call(self, endpoint, payload=None, image=None, query=None):
        for attempt in range(2):
            try:
                return self._post(endpoint, payload, self.access_token(), image, query)
            except ApiError as error:
                if error.code not in TOKEN_ERRORS or attempt:
                    raise
                self.token = ""
        raise AssertionError("unreachable")
