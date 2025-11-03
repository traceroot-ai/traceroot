# REST API

## Install Python Dependencies

```bash
# In the traceroot directory
python3.11 -m venv venv
source venv/bin/activate
pip install -e .
```

## Run the server

Start the server:

```bash
set -a
source .env.development
set +a
uvicorn rest.main:app --reload --reload-dir rest
```
