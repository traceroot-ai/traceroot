import os

import uvicorn
from dotenv import find_dotenv, load_dotenv

from rest.app import App

# Load environment variables from .env.local or .env
dotenv_path = find_dotenv(".env.local")
if not dotenv_path:
    dotenv_path = find_dotenv()

if dotenv_path:
    print(f"✅ Loading environment from {dotenv_path}")
    load_dotenv(dotenv_path, override=True)
    autumn_key = os.getenv("AUTUMN_SECRET_KEY")
    if not autumn_key:
        print("⚠️  WARNING: AUTUMN_SECRET_KEY not found in environment")
else:
    print("⚠️  WARNING: No .env file found")

app = App().app

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
