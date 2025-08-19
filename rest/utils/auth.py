import hashlib
from typing import Any

from fastapi import Request


def decode_user_email_from_secret(user_secret: str) -> str:
    pass


def decode_user_sub_from_secret(user_secret: str) -> str:
    pass


def get_user_credentials(request: Request) -> tuple[str, str, str]:
    fake_email = "user@example.com"
    fake_secret = "fake_secret"
    fake_sub = "fake_sub"
    return fake_email, fake_secret, fake_sub


def hash_user_sub(user_sub: str) -> str:
    hash_object = hashlib.sha256(user_sub.encode('utf-8'))
    hashed = hash_object.hexdigest()
    return hashed


def generate_traceroot_token() -> str:
    pass


def verify_cognito_token(token: str, token_use: str = "access"):
    pass


def generate_user_credentials(
    user_sub: str,
    user_email: str,
) -> dict[str,
          Any]:
    pass
