import logging
import os
from pathlib import Path

from dotenv import load_dotenv
from pydantic import BaseModel

# Set up logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Get the project root directory and load .env.local
project_root = Path(__file__).parent.parent.parent.parent
env_path = project_root / '.env.local'

# Load environment variables from .env.local
if env_path.exists():
    load_dotenv(env_path)
    logger.info(f"Loaded environment variables from: {env_path}")
else:
    logger.warning(f".env.local file not found at: {env_path}")


class AuthSettings(BaseModel):
    COGNITO_CLIENT_ID: str
    COGNITO_USER_POOL_ID: str
    COGNITO_CLIENT_SECRET: str
    COGNITO_ISSUER: str
    COGNITO_DOMAIN: str
    COGNITO_REDIRECT_URI: str
    AWS_REGION: str = "us-west-2"  # Default to us-west-2 if not specified

    @classmethod
    def from_env(cls) -> "AuthSettings":
        """Create settings from environment variables."""
        settings = cls(
            COGNITO_CLIENT_ID=os.getenv("COGNITO_CLIENT_ID", ""),
            COGNITO_USER_POOL_ID=os.getenv("COGNITO_USER_POOL_ID", ""),
            COGNITO_CLIENT_SECRET=os.getenv("COGNITO_CLIENT_SECRET", ""),
            COGNITO_ISSUER=os.getenv("COGNITO_ISSUER", ""),
            COGNITO_DOMAIN=os.getenv("COGNITO_DOMAIN", ""),
            COGNITO_REDIRECT_URI=os.getenv("COGNITO_REDIRECT_URI", ""),
            AWS_REGION=os.getenv("AWS_REGION", "us-west-2"),
        )

        # Log configuration
        logger.info("Auth Settings Configuration:")
        logger.info(f"COGNITO_CLIENT_ID: {settings.COGNITO_CLIENT_ID}")
        logger.info(f"COGNITO_USER_POOL_ID: {settings.COGNITO_USER_POOL_ID}")
        if settings.COGNITO_CLIENT_SECRET:
            logger.info(f"COGNITO_CLIENT_SECRET: "
                        f"{'*' * len(settings.COGNITO_CLIENT_SECRET)}")
        else:
            logger.info("COGNITO_CLIENT_SECRET is not set.")
        logger.info(f"AWS_REGION: {settings.AWS_REGION}")

        # Validate required settings
        if not all([settings.COGNITO_CLIENT_ID,
                    settings.COGNITO_USER_POOL_ID,
                    settings.COGNITO_CLIENT_SECRET,
                    settings.COGNITO_ISSUER,
                    settings.COGNITO_DOMAIN,
                    settings.COGNITO_REDIRECT_URI]):
            logger.warning(
                "One or more Cognito settings are not set. Authentication features may not work properly.")

        return settings


# Initialize settings
auth_settings = AuthSettings.from_env()
