# REST API

## Install Python Dependencies

```bash
python3.11 -m venv venv
source venv/bin/activate
cd traceroot
pip install -e .
```

## Run the server

Start the server:

```bash
uvicorn rest.main:app --reload --reload-dir rest
```
