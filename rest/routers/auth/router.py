import base64
import json
from datetime import datetime
from typing import Dict

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

try:
    from rest.utils.ee.auth import verify_cognito_token
except ImportError:
    from rest.utils.auth import verify_cognito_token

from rest.client.ee.mongodb_client import TraceRootMongoDBClient
from rest.config.subscription import UserSubscription


class AuthState(BaseModel):
    userInfo: Dict
    tokens: Dict


router = APIRouter()
db_client = TraceRootMongoDBClient()


@router.get("/auth-callback")
async def auth_callback(request: Request, state: str):
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
        verify_cognito_token(id_token, "id")

        # Create session data
        session_data = {
            "user_id": user_info.get("sub"),
            "email": user_info.get("email"),
            "name": user_info.get("name"),
            "token_use": access_claims.get("token_use"),
            "scope": access_claims.get("scope", "").split(),
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
            max_age=3600  # 1 hour
        )

        # Create trial subscription for new users
        user_email = user_info.get("email")
        if user_email:
            existing_subscription = await db_client.get_subscription(
                user_email, )
            if not existing_subscription:
                now = datetime.utcnow().isoformat()
                subscription = UserSubscription(user_email=user_email,
                                                hasAccess=True,
                                                subscription_plan="starter",
                                                start_date=now,
                                                is_trial=True,
                                                trial_start_date=now)
                await db_client.create_subscription(subscription)

        return response

    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
