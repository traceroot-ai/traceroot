To run any of the examples in this folder, you can either:

### Option 1: Copy the example environment file

```bash
# Open the .env file and update it with your actual Traceroot token and details
cp .env.example .env
python file_name.py
```

### Option 2: Manually export the environment variables

```
export TRACEROOT_SERVICE_NAME=example
export TRACEROOT_GITHUB_OWNER=traceroot-ai
export TRACEROOT_GITHUB_REPO_NAME=traceroot
export TRACEROOT_GITHUB_COMMIT_HASH=main
export TRACEROOT_TOKEN=your-actual-traceroot-token
export TRACEROOT_LOCAL_MODE=true
```

## Step 2: run any file using this command change file_name with any file present in the folder

python file_name.py
