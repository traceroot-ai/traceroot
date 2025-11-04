import re


def parse_github_url(url: str) -> tuple[str, str, str, str, int]:
    """
    Parse a GitHub URL and extract components.

    Args:
        url: GitHub URL in format:
            https://github.com/owner/repo/tree/ref/path/to/file#L123

    Returns:
        Tuple of (owner, repo_name, ref, file_path, line_number)
            Line number defaults to 1 if not specified in URL.

    Raises:
        ValueError: If URL format is invalid

    Example:
        >>> parse_github_url("https://github.com/traceroot-ai/traceroot-sdk/tree/main/examples/simple_example.py#L1")  # type: ignore  # noqa: E501
        ('traceroot-ai', 'traceroot-sdk', 'main',
        'examples/simple_example.py', 1)
    """
    # Remove fragment (line number) if present, default to 1
    line_number = 1
    if '#L' in url:
        url_part, fragment = url.split('#L', 1)
        try:
            line_number = int(fragment)
        except ValueError:
            line_number = 1  # Default to 1 if invalid line number format
        url = url_part

    if "?plain=1" in url:
        url = url.replace("?plain=1", "")

    # Match GitHub URL pattern
    pattern = r'https://github\.com/([^/]+)/([^/]+)/tree/([^/]+)/(.*)'
    match = re.match(pattern, url)

    if not match:
        raise ValueError(f"Invalid GitHub URL format: {url}")

    owner, repo_name, ref, file_path = match.groups()
    return owner, repo_name, ref, file_path, line_number
