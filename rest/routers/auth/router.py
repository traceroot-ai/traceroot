import base64
import json
from typing import Dict

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

try:
    from rest.utils.ee.auth import verify_cognito_token
except ImportError:
    from rest.utils.auth import verify_cognito_token

try:
    from rest.client.ee.mongodb_client import TraceRootMongoDBClient
except ImportError:
    from rest.client.mongodb_client import TraceRootMongoDBClient


class AuthState(BaseModel):
    userInfo: Dict
    tokens: Dict


router = APIRouter()
db_client = TraceRootMongoDBClient()


@router.get("/auth-callback")
async def auth_callback(request: Request, state: str) -> JSONResponse:
    try:
        # Decode the base64 state parameter
        decoded_bytes = base64.b64decode(state)
        decoded_state = json.loads(decoded_bytes.decode('utf-8'))
        auth_state = AuthState(**decoded_state)

        # Extract tokens and user info
        access_token = auth_state.tokens.get("accessToken")
        id_token = auth_state.tokens.get("idToken")
        user_info = auth_state.userInfo

        # Verify both tokens
        access_claims = verify_cognito_token(access_token, "access")

        id_claims = verify_cognito_token(id_token, "id")

        # Create session data
        session_data = {
            "user_id": user_info.get("sub"),
            "email": user_info.get("email"),
            "given_name": id_claims.get("given_name"),
            "family_name": id_claims.get("family_name"),
            "token_use": access_claims.get("token_use"),
            "scope": access_claims.get("scope", "").split(),
            "company": id_claims.get("custom:company"),
            "title": id_claims.get("custom:title"),
        }

        # Set up session/cookie
        response = JSONResponse({"status": "success", "user": session_data})

        # Set secure cookie with session info
        response.set_cookie(
            key="session",
            value=access_token,
            httponly=True,
            secure=True,
            samesite="lax",
            max_age=3600 * 12  # 12 hours
        )

        # Set ID token cookie for user identification
        # (contains email and other user claims)
        response.set_cookie(
            key="id_token",
            value=id_token,
            httponly=True,
            secure=True,
            samesite="lax",
            max_age=3600 * 12  # 12 hours
        )

        return response

    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/logout")
async def logout(request: Request) -> JSONResponse:
    """Logout endpoint that clears authentication cookies."""
    response = JSONResponse({
        "status": "success",
        "message": "Logged out successfully"
    })

    # Clear both authentication cookies
    response.delete_cookie(key="session")
    response.delete_cookie(key="id_token")

    return response
